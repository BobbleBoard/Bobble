/**
 * engine-doctor — which llama.cpp runs a given catalog model, and get it ready.
 *
 *   npx tsx packages/inference/tools/engine-doctor.mts            # what the state of play is
 *   npx tsx packages/inference/tools/engine-doctor.mts <modelId>  # resolve + build that model's engine
 *
 * The other half of the variant pipeline (llamacpp-variants.ts). Supporting a
 * new architecture is a manifest entry plus a catalog entry; this is how you
 * check the result without launching the app, and how you warm a multi-minute
 * build before a demo rather than during one.
 *
 * It reports what it can SEE — the architectures the installed binaries actually
 * export — rather than what the manifest claims, because the claim is the thing
 * under test.
 */
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { CATALOG, getCatalogModel } from '../src/catalog.js';
import { engineArchitectures, ensureEngineFor } from '../src/engine-select.js';
import { ensureLlamaCpp } from '../src/llamacpp-manager.js';
import { PINNED_LLAMACPP } from '../src/llamacpp-manifest.js';
import { LLAMACPP_VARIANTS, variantArchitectures } from '../src/llamacpp-variants.js';

const execFile = promisify(execFileCb) as never;
const [, , modelId] = process.argv;

const pinned = await ensureLlamaCpp();
const known = await engineArchitectures(pinned.serverPath);
console.log(`pinned engine   ${PINNED_LLAMACPP.tag}   ${pinned.serverPath}`);
console.log(
  `  provides      ${known === undefined ? '(libllama unreadable — variants stay in use)' : [...known].join(', ') || 'none of the variant architectures'}`,
);

console.log(`\ndeclared variants (${LLAMACPP_VARIANTS.length}):`);
for (const v of LLAMACPP_VARIANTS) {
  const retired = v.architectures.every((a) => known?.has(a.toLowerCase()) === true);
  console.log(
    `  ${v.id.padEnd(14)} ${v.architectures.join(',').padEnd(12)} ${v.source.repo}@${v.source.commit.slice(0, 8)}  ${retired ? 'RETIRED — the pinned engine has it now' : 'in use'}`,
  );
}

const declaring = CATALOG.filter((m) => m.architecture !== undefined);
console.log(`\ncatalog models declaring an architecture (${declaring.length}):`);
for (const m of declaring) console.log(`  ${m.id.padEnd(18)} ${m.architecture}   ${m.hfRepo}`);
console.log(`\nvariant architectures: ${variantArchitectures().join(', ')}`);

if (modelId === undefined) {
  console.log('\nPass a model id to resolve and build its engine.');
  process.exit(0);
}

const model = getCatalogModel(modelId);
if (model === undefined) {
  console.error(`\nno catalog model "${modelId}"`);
  process.exit(1);
}

console.log(`\nresolving the engine for ${model.displayName}…`);
const started = Date.now();
const engine = await ensureEngineFor(model, {
  execFileImpl: execFile,
  onProgress: (p) => console.log(`  [${p.phase}] ${p.note}`),
});
console.log(`\n  engine   ${engine.serverPath}`);
console.log(
  `  variant  ${engine.variantId ?? '(pinned release)'}   in ${((Date.now() - started) / 1000).toFixed(1)}s`,
);
if (engine.note !== undefined) console.log(`  why      ${engine.note}`);
const provides = await engineArchitectures(engine.serverPath);
const ok = model.architecture === undefined || provides?.has(model.architecture) === true;
console.log(`  provides ${provides === undefined ? '(unreadable)' : [...provides].join(', ')}`);
console.log(`\n${ok ? 'OK' : 'MISMATCH'}: ${model.id} needs "${model.architecture ?? '(any)'}"`);
process.exit(ok ? 0 : 1);
