/**
 * tools/recycle-posts.js
 *
 * "Recycles" articles that have not been touched for 12+ months by bumping their `lastmod:`
 * front-matter field to today. Hugo writes `lastmod` into sitemap.xml (<lastmod>) and the theme
 * shows it as "Diperbarui", which is the honest freshness signal search engines use.
 *
 * What changed compared with the old root-level recycle-posts.js:
 *   - `date:` (the real publish date) is NO LONGER overwritten; only `lastmod:` is bumped.
 *   - The front matter is edited surgically (no YAML re-serialize), so diffs stay one line.
 *   - drafts and non-article pages (no `categories`, e.g. terms-of-service.md) are skipped.
 *   - It no longer runs `hugo` or "pings" anything. Building + deploying is deploy.yml's job and
 *     IndexNow is submitted by tools/ping-indexnow.js AFTER the site is live — pinging from here
 *     (before the build was deployed) is what made the old ping useless.
 *
 * USAGE
 *   node tools/recycle-posts.js              apply
 *   node tools/recycle-posts.js --dry-run    list what would change
 *   node tools/recycle-posts.js --months=12  change the age threshold
 */

const fs     = require('fs');
const path   = require('path');
const matter = require('gray-matter');

const ARGS    = process.argv.slice(2);
const DRY     = ARGS.includes('--dry-run');
const MONTHS  = parseInt((ARGS.find(a => a.startsWith('--months=')) || '').replace('--months=', ''), 10) || 12;

const contentDir = path.join(__dirname, '..', 'content');
const now = new Date();

function walkMarkdownFiles(dir) {
  let results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) results = results.concat(walkMarkdownFiles(fullPath));
    else if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== '_index.md') results.push(fullPath);
  }
  return results;
}

// Surgically insert/update a `lastmod:` field within the RAW frontmatter text (gray-matter's
// .matter). `date:` is left untouched.
function setLastmod(rawMatter, newDate) {
  const line = `lastmod: "${newDate}"`;
  if (/^lastmod:\s*.*$/m.test(rawMatter)) return rawMatter.replace(/^lastmod:\s*.*$/m, line);
  if (/^date:\s*.*$/m.test(rawMatter)) return rawMatter.replace(/^(date:\s*.*)$/m, `$1\n${line}`);
  return `${rawMatter}\n${line}`;
}

function isArticle(data) {
  const c = data.categories;
  return Array.isArray(c) ? c.length > 0 : Boolean(c);
}

function recyclePost(filePath) {
  const parsed = matter(fs.readFileSync(filePath, 'utf8'));
  const { data, content } = parsed;

  if (data.draft === true) return false;   // never touch unpublished drafts
  if (!isArticle(data)) return false;      // site pages (terms-of-service, ...) are not recycled

  const postDate = new Date(data.date);
  if (isNaN(postDate.getTime())) return false;

  // Age is measured from the LAST touch (lastmod if present, otherwise date), so an article is
  // recycled again MONTHS months after its previous recycle/revision — not on every run.
  const lastTouch = data.lastmod ? new Date(data.lastmod) : postDate;
  const reference = isNaN(lastTouch.getTime()) ? postDate : lastTouch;
  const monthsDiff = (now.getFullYear() - reference.getFullYear()) * 12 + now.getMonth() - reference.getMonth();
  if (monthsDiff < MONTHS) return false;

  if (!DRY) {
    const newRawMatter = setLastmod(parsed.matter, now.toISOString().split('T')[0]);
    fs.writeFileSync(filePath, `---${newRawMatter}\n---\n${content}`);
  }
  return true;
}

const markdownFiles = walkMarkdownFiles(contentDir);
console.log(`📁 ${markdownFiles.length} .md files found in ${contentDir}.`);

let updated = 0;
for (const f of markdownFiles) {
  if (recyclePost(f)) {
    updated++;
    if (DRY) console.log(`   would recycle: ${path.relative(contentDir, f)}`);
  }
}

console.log(updated > 0
  ? `${updated} article(s) ${DRY ? 'would be ' : ''}recycled (lastmod bumped).`
  : 'No articles need recycling.');
