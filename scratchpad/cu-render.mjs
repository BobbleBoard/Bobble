/** Render every captured case through the REAL formatMacSnapshot, verbatim. */
import { readFileSync, readdirSync } from 'node:fs';
import { formatMacSnapshot } from '/Users/user/Desktop/OSS-harness/packages/mac-computer-use/src/format.ts';

const dir = new URL('./cu-cases/', import.meta.url).pathname;
const only = process.argv[2];
for (const f of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
  if (only !== undefined && !f.includes(only)) continue;
  const snap = JSON.parse(readFileSync(dir + f, 'utf8'));
  const text = formatMacSnapshot(snap);
  console.log(`\n${'='.repeat(78)}\n== ${f}  (${text.length} chars, ${text.split('\n').length} lines)\n${'='.repeat(78)}`);
  console.log(text);
}
