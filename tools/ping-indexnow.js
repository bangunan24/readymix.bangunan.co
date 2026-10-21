/**
 * tools/ping-indexnow.js
 *
 * Notifies IndexNow (Bing, Yandex, Seznam, Naver, ...) about pages that changed. Runs AFTER the
 * deploy (see .github/workflows/deploy.yml) so the pages and the key file are already live.
 *
 * USAGE
 *   node tools/ping-indexnow.js --old=<previous sitemap.xml>    submit new / changed URLs only
 *   node tools/ping-indexnow.js --all                          submit every URL in the sitemap
 *   node tools/ping-indexnow.js --since-days=7                 URLs whose <lastmod> is <= 7 days old
 *   node tools/ping-indexnow.js --ensure-key                   create the key + static/<key>.txt only
 *
 * OPTIONS
 *   --new=<file>       sitemap to read (default public/sitemap.xml)
 *   --site=<url>       site URL (default: baseURL from hugo.toml / config.toml)
 *   --dry-run          print what would be sent, send nothing
 *   --no-wait          do not poll for the key file (only for local testing)
 *
 * EXIT CODE: 0 = submitted (or nothing to submit), 1 = failed — so a broken ping shows up as a
 * red workflow run instead of being silently swallowed.
 */

const fs   = require('fs');
const path = require('path');
const { getSiteConfig } = require('./lib/site-config.js');
const {
  ensureIndexNowKey, readSitemapFile, diffSitemaps, urlsSince, waitForKeyLive, submitToIndexNow,
} = require('./lib/index-ping.js');

const ROOT = path.join(__dirname, '..');
const ARGS = process.argv.slice(2);
const arg = name => { const a = ARGS.find(x => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : null; };
const has = name => ARGS.includes(`--${name}`);

async function main() {
  const siteUrl = arg('site') || getSiteConfig().siteUrl;
  const newFile = path.resolve(ROOT, arg('new') || 'public/sitemap.xml');
  const dry = has('dry-run');

  console.log(`\n📣 IndexNow — ${siteUrl}`);
  const key = ensureIndexNowKey();

  if (has('ensure-key')) { console.log('Key ready.'); return 0; }

  const next = readSitemapFile(newFile);
  if (!next.size) { console.error(`❌ Sitemap not found or empty: ${newFile}`); return 1; }

  let urls;
  if (has('all')) urls = [...next.keys()];
  else if (arg('since-days')) urls = urlsSince(next, parseInt(arg('since-days'), 10) || 7);
  else {
    const oldPath = arg('old');
    if (!oldPath) { console.error('❌ Give one of: --old=<file>, --all, --since-days=N'); return 1; }
    const prev = readSitemapFile(path.resolve(oldPath));
    if (!prev.size) console.log('   ℹ️  No previous sitemap found — treating every URL as new.');
    urls = diffSitemaps(prev, next);
  }

  console.log(`   ${urls.length} URL(s) to submit (of ${next.size} in the sitemap).`);
  if (!urls.length) { console.log('   Nothing changed — nothing to submit.'); return 0; }
  urls.slice(0, 10).forEach(u => console.log(`     • ${u}`));
  if (urls.length > 10) console.log(`     … and ${urls.length - 10} more`);

  if (dry) { console.log('\n🧪 Dry run — nothing sent.'); return 0; }

  if (!has('no-wait')) {
    const live = await waitForKeyLive(siteUrl, key);
    if (!live) {
      console.error('❌ Aborting: submitting before the key file is public would be rejected (HTTP 403).');
      console.error('   Check that Cloudflare Pages deployed the latest commit, then run the "Ping IndexNow" workflow.');
      return 1;
    }
  }

  const res = await submitToIndexNow(siteUrl, urls, key);
  return res.ok ? 0 : 1;
}

main().then(code => process.exit(code)).catch(err => {
  console.error('\n💥 Fatal error:', err.message);
  process.exit(1);
});
