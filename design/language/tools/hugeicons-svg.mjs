/**
 * Hugeicons data → SVG markup, for review sheets and the design language's
 * assets: node design/language/tools/hugeicons-svg.mjs <out.json> Name1 Name2 …
 * (names without the "Icon" suffix). Writes { name: "<svg …>" }.
 */
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(path.resolve('packages/ui/package.json'));
const root = path.dirname(require.resolve('@hugeicons/core-free-icons/package.json'));
const kebab = (k) => k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
export async function hugeiconSvg(name) {
  const mod = await import(path.join(root, 'dist/esm', `${name}Icon.js`));
  const parts = mod.default
    .map(([tag, attrs]) => {
      const a = Object.entries(attrs)
        .filter(([k]) => k !== 'key')
        .map(([k, v]) => `${kebab(k)}="${v}"`)
        .join(' ');
      return `<${tag} ${a}/>`;
    })
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none">${parts}</svg>`;
}
const [out, ...names] = process.argv.slice(2);
if (out) {
  const res = {};
  for (const n of names) {
    try {
      res[n] = await hugeiconSvg(n);
    } catch {
      res[n] = null;
    }
  }
  writeFileSync(out, JSON.stringify(res));
}
