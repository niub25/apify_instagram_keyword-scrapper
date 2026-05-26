import { Actor } from 'apify';
import { chromium } from 'playwright';

await Actor.init();

const input = await Actor.getInput();
const {
    keywords: seedKeywords = ['hoka','eliud kipchoge','running shoes','marathon runner','trail running'],
    maxKeywords        = 3000,
    maxPagesPerKeyword = 50,
    sessionId,
    csrfToken,
    proxyConfiguration,
} = input;

if (!sessionId) {
    console.log('ERROR: sessionId is required!');
    await Actor.exit();
}

const proxyConfig = await Actor.createProxyConfiguration(
    proxyConfiguration ?? { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] }
);

function normalizeKeyword(value) {
    return String(value ?? '')
        .toLowerCase()
        .replace(/[#@]/g, ' ')
        .replace(/[^\p{L}\p{N}._\s-]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeUsername(value) {
    const username = String(value ?? '').toLowerCase().replace(/^@/, '').trim();
    return /^[a-z0-9._]{1,30}$/.test(username) ? username : '';
}

function addKeyword(queue, seenKeywords, keyword) {
    const normalized = normalizeKeyword(keyword);
    if (!normalized || seenKeywords.has(normalized) || queue.includes(normalized)) return false;
    queue.push(normalized);
    return true;
}

function keywordVariants(keyword) {
    const normalized = normalizeKeyword(keyword);
    if (!normalized) return [];

    const compact = normalizeKeyword(normalized.replace(/\s+/g, ''));
    const tokens = normalized.split(/\s+/).filter(t => t.length >= 3);
    const variants = new Set([normalized, compact, ...tokens]);

    for (const token of tokens) {
        variants.add(`${token} running`);
        variants.add(`${token} runner`);
        variants.add(`${token} marathon`);
        variants.add(`${token} training`);
        variants.add(`${token} shoes`);
    }

    return [...variants].filter(Boolean);
}

// ─── Restore state after migration ───────────────────────────────────────────

const savedState = await Actor.getValue('STATE') ?? {};
const seenUsers    = new Set(savedState.seenUsers    ?? []);
const seenKeywords = new Set(savedState.seenKeywords ?? []);
const keywordQueue = savedState.keywordQueue
    ?? [...new Set(seedKeywords.flatMap(keywordVariants).map(normalizeKeyword).filter(Boolean))];

console.log(`Restored state: ${seenUsers.size} users, ${seenKeywords.size} keywords done, ${keywordQueue.length} in queue`);

// ─── Save state on migration ──────────────────────────────────────────────────

Actor.on('migrating', async () => {
    await Actor.setValue('STATE', {
        seenUsers:    [...seenUsers],
        seenKeywords: [...seenKeywords],
        keywordQueue,
    });
    console.log(`State saved: ${seenUsers.size} users, ${seenKeywords.size} keywords, ${keywordQueue.length} queued`);
});

// ─── Launch browser ───────────────────────────────────────────────────────────

console.log('Launching browser...');
const proxyUrl  = await proxyConfig.newUrl('ig_browser');
const proxyHost = proxyUrl ? new URL(proxyUrl) : null;

const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-blink-features=AutomationControlled'],
    proxy: proxyHost ? {
        server:   `${proxyHost.protocol}//${proxyHost.host}`,
        username: proxyHost.username ? decodeURIComponent(proxyHost.username) : undefined,
        password: proxyHost.password ? decodeURIComponent(proxyHost.password) : undefined,
    } : undefined,
});

const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    viewport: { width: 390, height: 844 },
});

await context.addCookies([
    { name: 'sessionid', value: sessionId, domain: '.instagram.com', path: '/', httpOnly: true, secure: true },
    ...(csrfToken ? [{ name: 'csrftoken', value: csrfToken, domain: '.instagram.com', path: '/', secure: true }] : []),
]);

const igPage = await context.newPage();

console.log('Navigating to Instagram...');
await igPage.goto('https://www.instagram.com/', {
    waitUntil: 'commit',
    timeout: 60000,
}).catch(e => console.log(`Nav warning: ${e.message}`));

// ─── Instagram API caller ─────────────────────────────────────────────────────

async function igFetch(url) {
    try {
        const result = await igPage.evaluate(async (u) => {
            try {
                const r = await fetch(u, {
                    headers: {
                        'X-IG-App-ID': '936619743392459',
                        'X-ASBD-ID': '129477',
                        'Accept': '*/*',
                        'X-Requested-With': 'XMLHttpRequest',
                    },
                    credentials: 'include',
                });
                if (!r.ok) return { error: r.status };
                return { data: await r.json() };
            } catch (e) {
                return { error: e.message };
            }
        }, url);
        return result?.data ?? null;
    } catch {
        return null;
    }
}

// ─── Fetch one keyword search page ───────────────────────────────────────────

async function fetchKeywordPage(keyword) {
    const urls = [
        `https://www.instagram.com/web/search/topsearch/?context=blended&query=${encodeURIComponent(keyword)}&rank_token=0.1&include_reel=false`,
        `https://www.instagram.com/api/v1/web/search/topsearch/?context=blended&query=${encodeURIComponent(keyword)}&rank_token=0.1&include_reel=false`,
    ];

    for (const url of urls) {
        const data = await igFetch(url);
        if (data) {
            const users = [];
            const relatedKeywords = new Set();

            for (const item of (data.users ?? [])) {
                const user = item?.user ?? item;
                const username = normalizeUsername(user?.username);
                if (username) users.push(username);

                const fullName = normalizeKeyword(user?.full_name);
                if (fullName) relatedKeywords.add(fullName);

                for (const part of fullName.split(/\s+/).filter(p => p.length >= 3)) {
                    relatedKeywords.add(part);
                }
            }

            for (const item of (data.places ?? [])) {
                const title = normalizeKeyword(item?.place?.title ?? item?.title);
                if (title) relatedKeywords.add(title);
            }

            for (const item of (data.hashtags ?? [])) {
                const tag = normalizeKeyword(item?.hashtag?.name ?? item?.name);
                if (tag) relatedKeywords.add(tag);
            }

            return {
                usernames: [...new Set(users)],
                relatedKeywords: [...relatedKeywords],
                source: 'search',
            };
        }
    }

    return null;
}

// ─── Discover related keywords ────────────────────────────────────────────────

async function discoverRelated(keyword) {
    const found = new Set();

    for (const variant of keywordVariants(keyword)) {
        found.add(variant);
    }

    const search = await igFetch(`https://www.instagram.com/api/v1/tags/search/?q=${encodeURIComponent(keyword)}&count=15`);
    for (const r of (search?.results ?? [])) {
        const name = normalizeKeyword(r?.name);
        if (name) found.add(name);
    }

    return [...found];
}

// ─── Test API ─────────────────────────────────────────────────────────────────

console.log('Testing API...');
const testKeyword = normalizeKeyword(seedKeywords[0]) || 'running';
const test = await fetchKeywordPage(testKeyword);
if (!test) {
    console.log('ERROR: API test failed. Get fresh sessionid + csrftoken from Chrome and try again.');
    await browser.close();
    await Actor.exit();
}
console.log(`API working via [${test.source}]`);

// ─── Main: discover usernames ─────────────────────────────────────────────────

console.log(`\nStarting username discovery`);
console.log(`  Seed keywords     : ${seedKeywords.length}`);
console.log(`  Max keywords      : ${maxKeywords}`);
console.log(`  Pages per keyword : ${maxPagesPerKeyword}`);
console.log(`  Already done      : ${seenKeywords.size} keywords, ${seenUsers.size} users\n`);

const { Dataset } = await import('crawlee');

while (keywordQueue.length > 0 && seenKeywords.size < maxKeywords) {
    const keyword = keywordQueue.shift();
    if (!keyword || seenKeywords.has(keyword)) continue;
    seenKeywords.add(keyword);

    console.log(`\n[${seenKeywords.size}/${maxKeywords}] "${keyword}"`);

    // Discover related keywords first
    if (seenKeywords.size <= maxKeywords) {
        const related = await discoverRelated(keyword);
        let added = 0;
        for (const r of related) {
            if (seenKeywords.size + keywordQueue.length >= maxKeywords) break;
            if (addKeyword(keywordQueue, seenKeywords, r)) added++;
        }
        if (added > 0) console.log(`  +${added} related keywords → queue: ${keywordQueue.length}`);
    }

    // Search this keyword
    let pageNum = 0, keywordTotal = 0;
    const newUsersThisKeyword = [];

    while (pageNum < maxPagesPerKeyword) {
        pageNum++;
        const result = await fetchKeywordPage(keyword);
        if (!result) { console.log(`  p${pageNum}: failed`); break; }

        let newCount = 0;
        for (const u of result.usernames) {
            if (u && !seenUsers.has(u)) {
                seenUsers.add(u);
                newUsersThisKeyword.push(u);
                newCount++;
                keywordTotal++;
            }
        }

        for (const relatedKeyword of result.relatedKeywords) {
            if (seenKeywords.size + keywordQueue.length >= maxKeywords) break;
            addKeyword(keywordQueue, seenKeywords, relatedKeyword);
        }

        console.log(`  p${pageNum} [${result.source}]: +${newCount} | keyword total: ${keywordTotal} | all time: ${seenUsers.size}`);

        // Instagram top search does not expose a real next-page cursor. Re-querying
        // the same keyword would return the same users, so stop after one useful page.
        break;
    }

    // Save new usernames to dataset
    if (newUsersThisKeyword.length > 0) {
        for (const username of newUsersThisKeyword) {
            await Dataset.pushData({ username, discoveredFrom: keyword, scrapedAt: new Date().toISOString() });
        }
        console.log(`  Saved ${newUsersThisKeyword.length} new usernames`);
    }

    // Persist state every 10 keywords
    if (seenKeywords.size % 10 === 0) {
        await Actor.setValue('STATE', {
            seenUsers:    [...seenUsers],
            seenKeywords: [...seenKeywords],
            keywordQueue,
        });
        console.log(`  State saved (${seenKeywords.size} keywords done)`);
    }

    await new Promise(r => setTimeout(r, 400));
}

await browser.close();

// Final state save
await Actor.setValue('STATE', {
    seenUsers:    [...seenUsers],
    seenKeywords: [...seenKeywords],
    keywordQueue: [],
});

console.log(`\nDone!`);
console.log(`  Keywords processed : ${seenKeywords.size}`);
console.log(`  Unique usernames   : ${seenUsers.size}`);

await Actor.exit();
