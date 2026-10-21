/**
 * tools/lib/orphan-link.js
 *
 * Pure helper functions for fix-orphans.js's narrow "insert one verified link" task, split out
 * so the validation/parsing logic (the part that matters for safety) can be tested on its own.
 *
 * In short: the AI is asked to quote back ONE existing sentence verbatim plus that same
 * sentence with a link inserted, and the script applies it as an EXACT STRING SUBSTITUTION,
 * never a full rewrite.
 *
 * this site note: anchor text may contain Markdown-escaped characters (\[Terdekat\]),
 * so every link regex here accepts backslash-escapes inside the anchor.
 */

const ANCHOR = String.raw`((?:\\.|[^\]\\])+)`;
const ANY_LINK_G = new RegExp(String.raw`(?<!!)\[${ANCHOR}\]\(([^)\s]+)\)`, 'g');
const ANY_LINK_1 = new RegExp(String.raw`(?<!!)\[${ANCHOR}\]\(([^)\s]+)\)`);

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0, idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) { count++; idx += needle.length; }
  return count;
}

// Tolerant parser. Models often decorate the two labels (**KALIMAT_ASLI:**, "Kalimat asli:",
// `KALIMAT ASLI`, a numbered list, a code fence) or wrap the value in quotes/brackets. None of
// that changes the meaning, so it is stripped here; the strict checks stay in validateInsertion().
const LABEL_ORIG = String.raw`[\s>*_` + "`" + String.raw`#\-\d.)]*KALIMAT[_\s-]*ASLI[\s*_` + "`" + String.raw`]*[:：][*_` + "`" + String.raw`]*`;
const LABEL_NEW  = String.raw`[\s>*_` + "`" + String.raw`#\-\d.)]*KALIMAT[_\s-]*BARU[\s*_` + "`" + String.raw`]*[:：][*_` + "`" + String.raw`]*`;

function cleanValue(v) {
  let t = (v || '').trim();
  t = t.replace(/^```[a-z]*\s*\n?/i, '').replace(/\n?```\s*$/, '').trim();
  // strip ONE layer of wrapping quotes / the "[...]" placeholder brackets from the prompt format
  const pairs = [['"', '"'], ['\u201c', '\u201d'], ["'", "'"], ['`', '`']];
  for (const [o, c] of pairs) {
    if (t.length > 1 && t.startsWith(o) && t.endsWith(c)) { t = t.slice(1, -1).trim(); break; }
  }
  // "[sentence]" wrapper: strip only when the FIRST "[" is closed by the LAST "]" (balanced,
  // escapes ignored), so a real link or an escaped \\[Terdekat\\] anchor is never mangled.
  if (t.startsWith('[') && t.endsWith(']')) {
    let depth = 0, closesAtEnd = false;
    for (let i = 0; i < t.length; i++) {
      if (t[i] === '\\') { i++; continue; }
      if (t[i] === '[') depth++;
      else if (t[i] === ']') { depth--; if (depth === 0) { closesAtEnd = (i === t.length - 1); break; } }
    }
    if (closesAtEnd) t = t.slice(1, -1).trim();
  }
  return t;
}

function parseAIResponse(text) {
  const trimmed = (text || '').trim();
  const hasOrig = new RegExp(LABEL_ORIG, 'i').test(trimmed);
  const hasNew = new RegExp(LABEL_NEW, 'i').test(trimmed);
  if (/TIDAK[_\s]ADA[_\s]YANG[_\s]COCOK/i.test(trimmed) && !(hasOrig && hasNew)) return { noMatch: true };

  const origMatch = trimmed.match(new RegExp(LABEL_ORIG + String.raw`\s*([\s\S]*?)` + String.raw`\n[\s>*_` + '`' + String.raw`#\-\d.)]*KALIMAT[_\s-]*BARU`, 'i'));
  const newMatch  = trimmed.match(new RegExp(LABEL_NEW + String.raw`\s*([\s\S]*)$`, 'i'));
  if (!origMatch || !newMatch) {
    return { parseError: 'format tidak sesuai (KALIMAT_ASLI/KALIMAT_BARU tidak ditemukan)' };
  }
  // The updated sentence is the first non-empty paragraph after KALIMAT_BARU: anything after a
  // blank line is chatter ("Catatan: ...").
  const newFirst = newMatch[1].trim().split(/\n\s*\n/)[0];
  const original = cleanValue(origMatch[1]);
  const updated = cleanValue(newFirst);
  if (!original || !updated) return { parseError: 'KALIMAT_ASLI atau KALIMAT_BARU kosong' };
  return { original, updated };
}

/**
 * Validates a parsed {original, updated} pair BEFORE it's allowed to touch a file. Every check
 * is a hard reject (never "apply anyway"). Returns null when valid, otherwise a reason string.
 */
function validateInsertion(donorBody, orphanUrl, original, updated) {
  if (!original || original.length < 10) return 'kalimat asli kosong/terlalu pendek';
  if (/!\[.*?\]\(.*?\)|\{\{<.*?>\}\}/.test(original)) return 'kalimat asli mengandung gambar/shortcode (dilarang)';
  if (/^\s*(\*\*(Lainnya|Ref by):\*\*|#{1,6}\s)/.test(original)) return 'kalimat asli adalah baris navigasi/heading (dilarang)';

  const occurrences = countOccurrences(donorBody, original);
  if (occurrences === 0) return 'kalimat asli tidak ditemukan persis di file donor (AI tidak menyalin verbatim)';
  if (occurrences > 1) return `kalimat asli muncul ${occurrences}x di file donor (harus unik, tidak aman untuk substitusi otomatis)`;

  const linkMatches = [...updated.matchAll(ANY_LINK_G)];
  if (linkMatches.length !== 1) return `kalimat baru mengandung ${linkMatches.length} link (harus persis 1)`;
  const [, anchorText, linkUrl] = linkMatches[0];
  if (linkUrl !== orphanUrl) return `link menunjuk ke "${linkUrl}", seharusnya persis "${orphanUrl}"`;
  if (!anchorText.trim() || anchorText.trim().length < 3) return 'anchor text kosong/terlalu pendek';
  if (/^(klik di sini|baca juga|selengkapnya|di sini)$/i.test(anchorText.trim())) return `anchor text generik ditolak: "${anchorText.trim()}"`;

  // Guard against the AI quietly rewording more than just inserting the link: strip the link
  // back out and compare word-count delta against the original sentence.
  const delinked = updated.replace(ANY_LINK_1, '$1');
  const origWords = original.trim().split(/\s+/).length;
  const delinkedWords = delinked.trim().split(/\s+/).length;
  const maxAllowedExtra = Math.max(15, origWords);
  if (delinkedWords - origWords > maxAllowedExtra) {
    return `kalimat baru tampak diubah lebih dari sekadar menyisipkan link (${origWords} kata → ${delinkedWords} kata setelah link dilepas)`;
  }
  if (origWords - delinkedWords > 3) {
    return `kalimat baru tampak kehilangan sebagian isi kalimat asli (${origWords} kata → ${delinkedWords} kata setelah link dilepas)`;
  }

  // The sentence with the link taken out must still be the ORIGINAL sentence (only whitespace
  // differences tolerated) — i.e. the AI added a link, it did not rewrite words.
  const norm = s => s.replace(/\s+/g, ' ').trim();
  if (norm(delinked) !== norm(original)) {
    return 'kalimat baru berbeda dari kalimat asli selain penyisipan link (kata diubah)';
  }

  return null; // valid
}

// Minimal frontmatter split. rawMatter DELIBERATELY includes the leading "\n" (same convention
// as gray-matter's `.matter`) — reconstruction in applyInsertion() is `---${rawMatter}\n---\n${body}`.
function splitFrontMatter(raw) {
  const m = raw.match(/^---(\r?\n[\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return null;
  return { rawMatter: m[1], body: m[2] || '' };
}

// Surgically add/update `lastmod:` in the RAW frontmatter text, never a full YAML re-serialize
// (which would reformat the file). `date:` (original publish date) stays untouched.
function setLastmod(rawMatter, newDate) {
  const line = `lastmod: "${newDate}"`;
  if (/^lastmod:\s*.*$/m.test(rawMatter)) return rawMatter.replace(/^lastmod:\s*.*$/m, line);
  if (/^date:\s*.*$/m.test(rawMatter)) return rawMatter.replace(/^(date:\s*.*)$/m, `$1\n${line}`);
  return `${rawMatter}\n${line}`;
}

// Applies a validated {original, updated} pair to a donor file's raw content, returning the
// full new file text. Caller MUST have already run validateInsertion() and gotten null back.
function applyInsertion(rawMatter, body, original, updated, newDate) {
  const newBody = body.replace(original, () => updated); // function form: "$" in text is never special
  const newRawMatter = setLastmod(rawMatter, newDate);
  return `---${newRawMatter}\n---\n${newBody}`;
}

module.exports = {
  cleanValue,
  countOccurrences,
  parseAIResponse,
  validateInsertion,
  splitFrontMatter,
  setLastmod,
  applyInsertion,
};
