/**
 * tools/process-spintax.js
 *
 * Expands {option1|option2|...} spintax found in `[[params.testimonials]]` (hugo.toml /
 * config.toml) and writes the result to data/testimonials.yaml, which the theme reads via
 * `.Site.Data.testimonials`.
 *
 * Hooked into the build: package.json "prebuild" runs it automatically before `npm run build`
 * (and `npm start`), exactly like before — the file just lives in tools/ now.
 */

const fs = require('fs');
const path = require('path');
const toml = require('toml');
const yaml = require('js-yaml');
const { getSiteConfig } = require('./lib/site-config.js');

const rootDir = path.join(__dirname, '..');

// Hugo prefers hugo.toml over config.toml; read the same one it would.
function findConfigFile() {
  for (const name of ['hugo.toml', 'config.toml']) {
    const p = path.join(rootDir, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// __DOMAIN__ / __BRAND__ in testimonial text come from baseURL / [params] brand (single place to change).
function fillTokens(text) {
  if (typeof text !== 'string') return text;
  const { host, brand } = getSiteConfig();
  return text.replace(/__DOMAIN__/g, host).replace(/__BRAND__/g, brand);
}

function processSpintax(text) {
  if (typeof text !== 'string') return text;
  text = fillTokens(text);

  const regex = /\{([^{}]+)\}/g;
  let result = text;
  let match;

  while ((match = regex.exec(result)) !== null) {
    const options = match[1].split('|');
    const replacement = options[Math.floor(Math.random() * options.length)];
    result = result.substring(0, match.index) + replacement + result.substring(match.index + match[0].length);
    regex.lastIndex = 0; // Reset regex index
  }

  return result;
}

try {
  const configPath = findConfigFile();
  if (!configPath) {
    throw new Error('hugo.toml / config.toml not found in the project root.');
  }

  console.log(`Using config from: ${configPath}`);

  const config = toml.parse(fs.readFileSync(configPath, 'utf8'));
  const testimonials = (config.params && config.params.testimonials) || [];

  const processedTestimonials = testimonials.map(testimonial => ({
    ...testimonial,
    name: processSpintax(testimonial.name),
    message: processSpintax(testimonial.message),
    response: processSpintax(testimonial.response)
  }));

  const dataDir = path.join(rootDir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'testimonials.yaml'), yaml.dump({ testimonials: processedTestimonials }));

  console.log(`Testimonials processed (${processedTestimonials.length}) and data/testimonials.yaml written.`);
  if (processedTestimonials[0]) console.log(processedTestimonials[0].message);
} catch (error) {
  console.error('There is an error:', error.message);
  process.exit(1);
}
