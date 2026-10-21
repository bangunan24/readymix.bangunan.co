/**
 * tools/lib/index-ping.js
 *
 * Working URL-notification for this site (hosted on Cloudflare Pages).
 *
 * WHAT WAS WRONG BEFORE (old recycle-posts.js pingSearchEngines):
 *   - Google's and Bing's "ping?sitemap=" endpoints were retired (they return 404/410), the
 *     sitemaps.org "ping" never existed, pingomatic/feedburner via plain GET do nothing useful,
 *     and "indexnow.org/ping?sitemap=" is not an IndexNow endpoint.
 *   - The function was never awaited, so Node could exit before any request finished, and every
 *     failure was swallowed — so the log always looked "fine" while nothing was submitted.
 *   - It ran BEFORE the site was deployed, i.e. search engines were told about pages that were
 *     not live yet.
 *
 * WHAT WORKS TODAY:
 *   - IndexNow (Bing, Yandex, Seznam, Naver, ... — Google does NOT participate): a POST with a
 *     JSON body listing the EXACT URLs that were added/changed, plus a key proving domain
 *     ownership via a text file at the site root (static/<key>.txt → https://host/<key>.txt).
 *   - Google: there is no supported "push this URL" call for ordinary pages (the Indexing API is
 *     only for JobPosting / BroadcastEvent). Google's signal is an accurate sitemap.xml with a
 *     correct <lastmod>, which this repo produces (recycle / revise / fix-orphans bump `lastmod`
 *     in the front matter and Hugo writes it into the sitemap). Submit
 *     https://<domain>/sitemap.xml once in Google Search Console.
 *
 * HOW CHANGED URLS ARE DETECTED (workflow-agnostic):
 *   deploy.yml saves the previously committed public/sitemap.xml before building, builds, and
 *   then diffs old vs new sitemap: a URL that is new, or whose <lastmod> changed, is "changed".
 *   Hugo's random per-build output (meta keywords, spintax testimonials) never touches <lastmod>,
 *   so it cannot cause false positives.
 *
 * ORDER MATTERS: submit only AFTER the push, and only once https://host/<key>.txt really answers
 * with the key (Cloudflare Pages needs a short while to publish the commit). waitForKeyLive()
 * polls for that.
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const ROOT           = path.join(__dirname, '..', '..');
const KEY_STATE_FILE = path.join(ROOT, '.indexnow-key.json');
const STATIC_DIR     = path.join(ROOT, 'static');

const INDEXNOW_HOST = 'api.indexnow.org';
const INDEXNOW_PATH = '/indexnow';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Returns this site's persistent IndexNow key, generating it (and the required
 * static/<key>.txt verification file) only if it does not exist yet. The SAME key must keep
 * being used forever, so .indexnow-key.json and static/<key>.txt are committed to git.
 */
function ensureIndexNowKey() {
  let key;
  if (fs.existsSync(KEY_STATE_FILE)) {
    try { key = JSON.parse(fs.readFileSync(KEY_STATE_FILE, 'utf8')).key; } catch { key = null; }
  }
  if (!key || !/^[a-f0-9]{32}$/i.test(key)) {
    key = crypto.randomBytes(16).toString('hex');
    fs.writeFileSync(KEY_STATE_FILE, JSON.stringify({ key, createdAt: new Date().toISOString() }, null, 2) + '\n');
    console.log(`   🔑 New IndexNow key generated and saved to ${path.basename(KEY_STATE_FILE)}.`);
  }

  const keyFilePath = path.join(STATIC_DIR, `${key}.txt`);
  if (!fs.existsSync(keyFilePath) || fs.readFileSync(keyFilePath, 'utf8') !== key) {
    if (!fs.existsSync(STATIC_DIR)) fs.mkdirSync(STATIC_DIR, { recursive: true });
    fs.writeFileSync(keyFilePath, key); // content must be EXACTLY the key, no newline/whitespace
    console.log(`   🔑 IndexNow key file written: static/${key}.txt`);
  }
  return key;
}

// ─── Sitemap parsing / diffing ──────────────────────────────────────────
function decodeXml(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

/** @returns {Map<string,string>} loc -> lastmod ('' when the entry has no <lastmod>) */
function parseSitemap(xml) {
  const map = new Map();
  const re = /<url>([\s\S]*?)<\/url>/g;
  let m;
  while ((m = re.exec(xml || ''))) {
    const loc = (m[1].match(/<loc>\s*([^<]+?)\s*<\/loc>/) || [])[1];
    if (!loc) continue;
    const lastmod = (m[1].match(/<lastmod>\s*([^<]+?)\s*<\/lastmod>/) || [])[1] || '';
    map.set(decodeXml(loc), lastmod);
  }
  return map;
}

function readSitemapFile(file) {
  try { return parseSitemap(fs.readFileSync(file, 'utf8')); } catch { return new Map(); }
}

/** URLs that are new in `next` or whose lastmod differs from `prev`. */
function diffSitemaps(prev, next) {
  const changed = [];
  for (const [loc, lastmod] of next) {
    if (!prev.has(loc) || prev.get(loc) !== lastmod) changed.push(loc);
  }
  return changed;
}

/** URLs in `map` whose lastmod is within the last `days` days. */
function urlsSince(map, days) {
  const cutoff = Date.now() - days * 86400 * 1000;
  return [...map].filter(([, lm]) => lm && new Date(lm).getTime() >= cutoff).map(([loc]) => loc);
}

// ─── Network ────────────────────────────────────────────────────────────
/**
 * Polls https://host/<key>.txt until it answers 200 with exactly the key.
 * Cloudflare Pages publishes a pushed commit after a short delay, so this is normally ~1-3 min.
 */
async function waitForKeyLive(siteUrl, key, { timeoutMs = 8 * 60 * 1000, intervalMs = 15000 } = {}) {
  const url = `${siteUrl.replace(/\/$/, '')}/${key}.txt`;
  const deadline = Date.now() + timeoutMs;
  let attempt = 0, lastNote = 'no response yet';
  while (Date.now() < deadline) {
    attempt++;
    try {
      // cache-buster so a CDN edge never serves a stale 404 for the key file
      const res = await fetch(`${url}?cb=${Date.now()}`, { signal: AbortSignal.timeout(15000), redirect: 'follow' });
      const text = (await res.text()).trim();
      if (res.status === 200 && text === key) {
        console.log(`   ✅ Key file is live (${url}) after ${attempt} check(s).`);
        return true;
      }
      lastNote = `HTTP ${res.status}${res.status === 200 ? ' but body != key' : ''}`;
    } catch (err) {
      // Node's fetch hides the real reason in err.cause (ENOTFOUND = DNS, ECONNREFUSED, cert errors...)
      const code = err.cause && (err.cause.code || err.cause.message);
      lastNote = code ? `${err.message}: ${code}` : err.message;
      if (code === 'ENOTFOUND') lastNote += ' — domain does not resolve; is the domain from baseURL attached to the Cloudflare Pages project?';
    }
    console.log(`   ⏳ Waiting for the deploy to go live (${lastNote}) — retry in ${intervalMs / 1000}s...`);
    await sleep(intervalMs);
  }
  console.warn(`   ❌ Key file did not become live within ${Math.round(timeoutMs / 60000)} min (${url}): ${lastNote}`);
  return false;
}

/**
 * POSTs `urls` (full https:// page URLs on the same host as siteUrl — NOT a sitemap URL) to
 * IndexNow in batches of up to 10,000. Returns { ok, submitted, results }.
 */
async function submitToIndexNow(siteUrl, urls, key) {
  const host = new URL(siteUrl).host;
  const sameHost = [...new Set(urls)].filter(u => { try { return new URL(u).host === host; } catch { return false; } });
  if (!sameHost.length) return { ok: true, submitted: 0, skipped: 'no URLs to submit' };

  const keyLocation = `${siteUrl.replace(/\/$/, '')}/${key}.txt`;
  const results = [];
  let allOk = true;

  for (let i = 0; i < sameHost.length; i += 10000) {
    const batch = sameHost.slice(i, i + 10000);
    const payload = { host, key, keyLocation, urlList: batch };
    try {
      const res = await fetch(`https://${INDEXNOW_HOST}${INDEXNOW_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30000),
      });
      const body = (await res.text()).slice(0, 300);
      // 200 = OK, 202 = accepted (key validation pending). Everything else is a real problem:
      // 400 bad request, 403 key/keyLocation invalid, 422 URL/host mismatch, 429 too many requests.
      if (res.status === 200 || res.status === 202) {
        console.log(`   ✅ IndexNow: ${batch.length} URL(s) accepted (HTTP ${res.status}).`);
        results.push({ statusCode: res.status, count: batch.length, ok: true });
      } else {
        allOk = false;
        console.error(`   ❌ IndexNow rejected the submission: HTTP ${res.status} ${body}`);
        results.push({ statusCode: res.status, count: batch.length, ok: false, body });
      }
    } catch (err) {
      allOk = false;
      console.error(`   ❌ IndexNow request failed: ${err.message}`);
      results.push({ count: batch.length, ok: false, error: err.message });
    }
  }
  return { ok: allOk, submitted: sameHost.length, results };
}

module.exports = {
  ensureIndexNowKey,
  parseSitemap,
  readSitemapFile,
  diffSitemaps,
  urlsSince,
  waitForKeyLive,
  submitToIndexNow,
};
