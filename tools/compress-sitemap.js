const fs = require('fs');
const zlib = require('zlib');
const path = require('path');
const toml = require('toml');

// Paths are relative to the repo root (this file lives in tools/)
const rootDir = path.join(__dirname, '..');
const sitemapPath = path.join(rootDir, 'public', 'sitemap.xml');
const sitemapGzipPath = path.join(rootDir, 'public', 'sitemap.xml.gz');
const robotsPath = path.join(rootDir, 'public', 'robots.txt');

// Reads baseURL from hugo.toml (the file Hugo itself prefers), falling back to config.toml
function getBaseUrl() {
  for (const name of ['hugo.toml', 'config.toml']) {
    const p = path.join(rootDir, name);
    if (fs.existsSync(p)) {
      const config = toml.parse(fs.readFileSync(p, 'utf-8'));
      if (config.baseURL) return config.baseURL.endsWith('/') ? config.baseURL.slice(0, -1) : config.baseURL;
    }
  }
  throw new Error('baseURL not found in hugo.toml / config.toml');
}

// Writes robots.txt (with rules for archive/pagination pages and both sitemap URLs).
// Cloudflare Pages serves it from public/ exactly as written here.
function ensureRobotsTxt() {
  const baseUrl = getBaseUrl();

  const robotsContent = `
User-agent: *
Allow: /

Disallow: /categories/*/page/
Noindex: /categories/*/page/
Disallow: /tags/*/page/
Noindex: /tags/*/page/
Disallow: /page/
Noindex: /page/

Sitemap: ${baseUrl}/sitemap.xml
Sitemap: ${baseUrl}/sitemap.xml.gz
  `;

  fs.writeFileSync(robotsPath, robotsContent.trim() + '\n');
  console.log('robots.txt was created or updated successfully.');
}

// Compresses sitemap.xml into sitemap.xml.gz
function compressSitemap() {
  const gzip = zlib.createGzip();
  const source = fs.createReadStream(sitemapPath);
  const destination = fs.createWriteStream(sitemapGzipPath);

  source.pipe(gzip).pipe(destination).on('finish', () => {
    console.log('sitemap.xml successfully compressed into sitemap.xml.gz');
  }).on('error', (err) => {
    console.error('Error while compressing sitemap:', err);
    process.exitCode = 1;
  });
  source.on('error', (err) => {
    console.error('Cannot read sitemap.xml (did the Hugo build run?):', err.message);
    process.exitCode = 1;
  });
}

ensureRobotsTxt();
compressSitemap();
