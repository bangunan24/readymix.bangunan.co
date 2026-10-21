/**
 * tools/lib/site-config.js
 *
 * SINGLE source of truth for the site's domain in every script under tools/.
 * Reads hugo.toml (falls back to config.toml):
 *     baseURL = "https://example.com/"      -> site URL / host
 *     [params] brand = "example.com"        -> brand name the AI must keep in rewritten articles
 * To change the domain, edit those two values (in BOTH hugo.toml and config.toml) and nothing else.
 *
 * Deliberately dependency-free (no `toml` package): find-orphans / fix-orphans run in a workflow
 * that does not call `npm ci`. Only the two simple keys above are needed, so a small reader is enough.
 * Overrides for one-off runs: env SITE_URL, SITE_BRAND, SITE_HOSTS (extra hosts, comma-separated).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

function readConfigText() {
  for (const f of ['hugo.toml', 'config.toml']) {
    const p = path.join(ROOT, f);
    if (fs.existsSync(p)) return { file: f, text: fs.readFileSync(p, 'utf8') };
  }
  throw new Error('hugo.toml / config.toml not found in the project root.');
}

// First `key = "value"` at top level (before any [table]) or inside [params].
function readKey(text, key, section) {
  let inSection = section === null; // null = top level
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const table = line.match(/^\[\[?([^\]]+)\]\]?$/);
    if (table) { inSection = table[1].trim() === section; if (section === null) return null; continue; }
    if (!inSection) continue;
    const m = line.match(new RegExp(`^${key}\\s*=\\s*(["'])(.*?)\\1`));
    if (m) return m[2];
  }
  return null;
}

let cached = null;
function getSiteConfig() {
  if (cached) return cached;
  const { file, text } = readConfigText();
  const baseURL = process.env.SITE_URL || readKey(text, 'baseURL', null);
  if (!baseURL) throw new Error(`baseURL is not set in ${file} — it is the single place the domain is defined.`);
  const url = new URL(baseURL);
  const siteUrl = `${url.protocol}//${url.host}/`;
  const host = url.host;
  // brand: explicit [params] brand, else the host without its first label (bambu.example.com -> example.com)
  const brand = process.env.SITE_BRAND || readKey(text, 'brand', 'params') ||
    (host.split('.').length > 2 ? host.split('.').slice(1).join('.') : host);
  const extra = (process.env.SITE_HOSTS || '').split(',').map(s => s.trim()).filter(Boolean);
  cached = { baseURL: siteUrl, siteUrl, host, hosts: [...new Set([host, ...extra])], brand, configFile: file };
  return cached;
}

module.exports = { getSiteConfig };
