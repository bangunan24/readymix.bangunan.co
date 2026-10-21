/**
 * tools/lib/related-articles.js
 *
 * NON-AI internal-linking support, shared by revise-articles.js and find-orphans.js.
 *
 *   1. buildArticleIndex(contentRoot)   — scans content/**\/*.md once, builds a lightweight
 *      in-memory index (title, url, category, a short excerpt).
 *   2. guessCategoryHint(text, cats)    — cheap heuristic: does a known category name literally
 *      appear in the keyword/title?
 *   3. findRelatedCandidates(...)       — scores every indexed article against the current
 *      title: product words must overlap (the "satu tema" rule), and a SAME / NEARBY LOCATION
 *      word boosts the ranking (so a Bogor page links to another Bogor page first).
 *   4. formatCandidatesForPrompt(...)   — turns the candidate list into the text block that is
 *      injected into the AI prompt (title + url + excerpt).
 *   5. enforceInternalLinks(...)        — SAFETY NET run on the AI's output: strips any internal
 *      link that ISN'T one of the offered candidate URLs and hard-caps the total to 2.
 *
 * this site layout note (differs from betoncorplus):
 *   - Articles are FLAT: content/<slug>.md  →  URL /<slug>/  (see [permalinks] in hugo.toml).
 *   - The "category" comes from the front matter (`categories: [harga]`), not from a folder.
 *   - A file WITHOUT `categories` (e.g. content/terms-of-service.md) is a site page, not an
 *     article, and is never indexed / linked / revised.
 *   - Existing articles link to each other with ABSOLUTE urls (https://<domain>/slug/)
 *     and Markdown-escaped brackets in the anchor (`\[Terdekat\]`). Both are understood here.
 *
 * Deliberately dependency-free (no gray-matter) so it works in every CI job.
 */

const fs   = require('fs');
const path = require('path');

// Hosts that count as "this site" when a link is written as an absolute URL.
// Taken from baseURL in hugo.toml (see tools/lib/site-config.js); never hardcode the domain here.
const SITE_HOSTS = require('./site-config.js').getSiteConfig().hosts;

// Folders directly under content/ that are NOT thematic articles.
const EXCLUDED_CATEGORY_FOLDERS = new Set(['home', 'page']);

// Broad marketing/business boilerplate words ignored when scoring topical relatedness.
// the product word of each site ('bambu', 'genteng', 'kanopi') is in EVERY title, so it carries no signal at all.
const RELATED_STOPWORDS = new Set([
  'jual', 'jasa', 'harga', 'sewa', 'beli', 'biaya', 'tukang', 'pasang', 'tempat', 'menyewakan',
  'di', 'ke', 'dari', 'untuk', 'dan', 'yang', 'dengan', 'atau', 'per', 'apa', 'itu', 'ini',
  'terbaik', 'berkualitas', 'gratis', 'ongkir', 'murah', 'terpercaya', 'terdekat', 'bagus',
  'professional', 'profesional', 'area', 'lokasi', 'wilayah', 'daerah', 'kota', 'kabupaten',
  'kecamatan', 'jabodetabek', 'anda', 'kami', 'material', 'konstruksi', 'desain', 'interior',
  'bangunan', 'apakah', 'pengertian', 'alternatif', 'panduan', 'lengkap', 'cara', 'tips',
  'mengenal', 'kenali', 'memilih', 'adalah', 'dalam', 'pada', 'juga', 'akan', 'bisa', 'dapat',
  'kuat', 'awet', 'tahan', 'lama', 'baik', 'jenis', 'macam', 'model', 'membuat', 'minimalis',
  'terbaru', 'contoh', 'proses', 'sederhana', 'yaitu', 'ialah',
  'bambu', 'genteng', 'kanopi',
]);

function significantWords(text) {
  return (text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter(w => w.length > 2 && !RELATED_STOPWORDS.has(w));
}

// Titles follow "[Product/Service] di [Location][optional suffix]" (e.g. "Jual Bambu Steger di
// Ancol Jakarta [Terdekat]"). The part BEFORE the first standalone "di" is the product/topic;
// the part AFTER it is the location.
function splitTitle(text) {
  const t = text || '';
  const m = t.match(/\bdi\b/i);
  if (!m) return { topic: t.trim(), location: '' };
  return { topic: t.slice(0, m.index).trim(), location: t.slice(m.index + m[0].length).trim() };
}

function stripLocationForMatching(text) {
  return splitTitle(text).topic || text || '';
}

function significantWordsForMatching(text) {
  return significantWords(stripLocationForMatching(text));
}

function locationWords(text) {
  return significantWords(splitTitle(text).location);
}

// Lightweight frontmatter split — regex-based on purpose (see file header). Extracts only the
// fields we need: title, draft, categories.
function parseTitle(yamlBlock) {
  let m = yamlBlock.match(/^title:\s*'((?:[^']|'')*)'\s*$/m);
  if (m) return m[1].replace(/''/g, "'").trim();
  m = yamlBlock.match(/^title:\s*"((?:[^"\\]|\\.)*)"/m);
  if (m) return m[1].replace(/\\"/g, '"').trim();
  m = yamlBlock.match(/^title:\s*(.+?)\s*$/m);
  return m ? m[1].trim() : '';
}

function parseCategories(yamlBlock) {
  // Block list:   categories:\n  - harga
  let m = yamlBlock.match(/^categories:\s*\r?\n((?:[ \t]+-[ \t]*.+\r?\n?)+)/m);
  if (m) {
    return m[1].split(/\r?\n/).map(l => l.replace(/^[ \t]+-[ \t]*/, '').replace(/^['"]|['"]$/g, '').trim()).filter(Boolean);
  }
  // Inline list:  categories: [harga, bambu]   or string  categories: "[harga]" / harga
  m = yamlBlock.match(/^categories:\s*(.+?)\s*$/m);
  if (m) {
    return m[1].replace(/^['"]|['"]$/g, '').replace(/^\[|\]$/g, '').split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  }
  return [];
}

function splitFrontMatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { title: '', draft: false, categories: [], content: raw };
  const yamlBlock = m[1];
  const draftMatch = yamlBlock.match(/^draft:\s*(true|false)/m);
  return {
    title: parseTitle(yamlBlock),
    draft: draftMatch ? draftMatch[1] === 'true' : false,
    categories: parseCategories(yamlBlock),
    content: m[2] || '',
  };
}

function toUrl(filePath, contentRoot) {
  return '/' + path.relative(contentRoot, filePath).replace(/\\/g, '/').replace(/\.md$/, '') + '/';
}

// Flat layout → first front-matter category; nested layout → the folder under content/ (or
// under content/categories/).
function toCategory(filePath, contentRoot, fmCategories) {
  if (fmCategories && fmCategories.length) return fmCategories[0];
  const parts = path.relative(contentRoot, filePath).replace(/\\/g, '/').split('/');
  if (parts.length === 1) return '(root)';
  if (parts[0] === 'categories' && parts.length > 2) return parts[1];
  return parts[0] || '(root)';
}

// Short plain-text excerpt of the article BODY — lets the AI actually "study" the related
// article instead of only seeing a title.
function extractExcerpt(body, maxChars = 220) {
  const plain = (body || '')
    .replace(/!\[.*?\]\(.*?\)/g, ' ')                                   // images
    .replace(/\{\{<[\s\S]*?>\}\}/g, ' ')                                // Hugo shortcodes
    .replace(/<table[\s\S]*?<\/table>/gi, ' ')                          // rendered safe-tables
    .replace(/\[\[TABEL_MULAI\]\][\s\S]*?\[\[TABEL_SELESAI\]\]/g, ' ')  // safe-table blocks, if present
    .replace(/\[\[\[PLACEHOLDER_\d+\]\]\]/g, ' ')                       // revise-articles protection tokens
    .replace(/\*\*(Lainnya|Ref by):\*\*.*$/gm, ' ')                     // navigation / reference lines
    .replace(/\\([\[\]])/g, '$1')                                       // markdown-escaped brackets
    .replace(/[#*_>`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.slice(0, maxChars);
}

/**
 * Scans content/**\/*.md (recursively), skipping _index.md, draft:true files and files that
 * are not articles (no `categories` in the front matter). Run ONCE per script execution and
 * reuse it.
 *
 * opts.includeBody (default false): also keep the full raw body on each entry (as `.body`).
 * find-orphans.js turns it on since it needs full bodies to extract every outbound link.
 */
function buildArticleIndex(contentRoot, opts = {}) {
  const index = [];
  if (!fs.existsSync(contentRoot)) return index;

  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (dir === contentRoot && EXCLUDED_CATEGORY_FOLDERS.has(entry.name)) continue;
        walk(full);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.md') || entry.name === '_index.md') continue;

      let raw;
      try { raw = fs.readFileSync(full, 'utf8'); } catch { continue; }
      const { title, draft, categories, content } = splitFrontMatter(raw);
      if (!title || draft) continue;
      if (!categories.length) continue; // site page (e.g. terms-of-service), not an article

      index.push({
        file: full,
        url: toUrl(full, contentRoot),
        title,
        category: toCategory(full, contentRoot, categories),
        words: significantWordsForMatching(title),
        locWords: locationWords(title),
        excerpt: extractExcerpt(content),
        ...(opts.includeBody ? { body: content } : {}),
      });
    }
  }

  walk(contentRoot);
  return index;
}

/**
 * Rule-based hint only (never a hard filter): does a known category name appear as a whole
 * significant word in the title?
 */
function guessCategoryHint(text, knownCategories) {
  const words = new Set(significantWords(text));
  for (const cat of knownCategories) {
    if (words.has(String(cat).toLowerCase())) return cat;
  }
  return null;
}

function scoreCandidate(queryWords, queryLocWords, categoryHint, candidate) {
  const shared = queryWords.filter(w => candidate.words.includes(w));
  const sharedLoc = queryLocWords.filter(w => (candidate.locWords || []).includes(w));
  let score = shared.length;
  score += 0.5 * sharedLoc.length; // same / nearby area ranks first, never required
  if (categoryHint && candidate.category === categoryHint) score += 1;
  return { score, sharedCount: shared.length };
}

/**
 * "Satu tema" selection — NON-AI. Ranks every indexed article by significant-word overlap on the
 * PRODUCT part of the title, boosted by a shared location word. Returns up to `opts.max`
 * candidates ({ url, title, excerpt }), best match first. Empty array if nothing clears
 * `opts.minShared` — callers must treat that as "no internal link", not an error.
 */
function findRelatedCandidates({ text, excludeUrl, categoryHint }, index, opts = {}) {
  const max = opts.max || 6;
  const minShared = opts.minShared != null ? opts.minShared : 1;

  const queryWords = significantWordsForMatching(text);
  const queryLocWords = locationWords(text);
  if (!queryWords.length) return [];

  const scored = index
    .filter(a => a.url !== excludeUrl)
    .map(a => ({ a, ...scoreCandidate(queryWords, queryLocWords, categoryHint, a) }))
    .filter(x => x.sharedCount >= minShared)
    .sort((x, y) => y.score - x.score);

  return scored.slice(0, max).map(x => ({ url: x.a.url, title: x.a.title, excerpt: x.a.excerpt }));
}

function formatCandidatesForPrompt(candidates) {
  if (!candidates.length) {
    return '(Tidak ada artikel terkait yang cukup relevan untuk topik ini — lewati instruksi internal link, tidak perlu memaksakan.)';
  }
  return candidates.map((c, i) =>
    `${i + 1}. [${c.title}](${c.url})\n   Ringkasan isi: ${c.excerpt || '(tidak ada ringkasan)'}`
  ).join('\n');
}

// ─── Link parsing ───────────────────────────────────────────────────────
// Anchor text may contain Markdown-escaped characters such as \[Terdekat\] — `(?:\\.|[^\]\\])+`
// accepts a backslash-escape OR any char except "]" / "\". The target is either a site-relative
// path ("/slug/") or an absolute URL on one of SITE_HOSTS.
const HOST_ALT = SITE_HOSTS.map(h => h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
const LINK_RE_SRC = String.raw`(?<!!)\[((?:\\.|[^\]\\])+)\]\(((?:https?:\/\/(?:${HOST_ALT}))?\/[^)\s]*\/)\)`;

function normalizeInternalUrl(url) {
  return url.replace(new RegExp(`^https?:\\/\\/(?:${HOST_ALT})`, 'i'), '');
}

/**
 * SAFETY NET — run on the AI output AFTER the call (and BEFORE protected lines are restored):
 *   - an internal link is only kept if its normalized URL is EXACTLY one of the offered
 *     candidate URLs;
 *   - never more than `maxLinks` internal links total (default 2); extras are demoted back to
 *     plain text (anchor text kept), so the sentence still reads naturally.
 * External links, tel: and WhatsApp links are left alone. Image markdown is excluded via the "!"
 * lookbehind.
 */
function enforceInternalLinks(body, candidateUrls, maxLinks = 2) {
  const valid = new Set(candidateUrls || []);
  let kept = 0;
  return body.replace(new RegExp(LINK_RE_SRC, 'g'), (match, anchorText, url) => {
    const rel = normalizeInternalUrl(url);
    if (kept >= maxLinks || !valid.has(rel)) return anchorText;
    kept++;
    return match;
  });
}

/**
 * Extracts every internal link target from a body of Markdown, normalized to "/slug/".
 * Used by find-orphans.js to build the inbound-link graph.
 */
function extractOutboundUrls(body) {
  const urls = new Set();
  const re = new RegExp(LINK_RE_SRC, 'g');
  let m;
  while ((m = re.exec(body || ''))) urls.add(normalizeInternalUrl(m[2]));
  return [...urls];
}

module.exports = {
  buildArticleIndex,
  guessCategoryHint,
  findRelatedCandidates,
  formatCandidatesForPrompt,
  enforceInternalLinks,
  extractOutboundUrls,
  splitFrontMatter,
  significantWords,
  significantWordsForMatching,
  stripLocationForMatching,
  LINK_RE_SRC,
};
