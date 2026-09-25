#!/usr/bin/env node
/**
 * Pin uv: write `src/uv-pins.ts` from a uv GitHub release, or check it.
 *
 *   node scripts/pin-uv.mjs            regenerate for the version already pinned
 *   node scripts/pin-uv.mjs 0.11.29    bump: pin every build of that release
 *   node scripts/pin-uv.mjs --check    exit 1 unless the committed pins equal upstream
 *
 * Only small files are fetched — never an archive:
 *   - the GitHub releases API (asset names, sizes, and GitHub's own sha256 digests);
 *   - the release's `sha256.sum` (the checksums uv publishes), verified against
 *     the API digest of that file;
 *   - the release's `uv-installer.sh`, verified the same way, for the oldest glibc
 *     each Linux glibc build accepts (its `check_glibc` calls).
 * Every archive's sha256 must agree between `sha256.sum` and the API, or nothing
 * is written. Set GITHUB_TOKEN to lift the API rate limit (CI does).
 *
 * The output is deterministic (sorted, no timestamps), so `--check` is a plain
 * regenerate-and-compare.
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = 'astral-sh/uv';
const here = dirname(fileURLToPath(import.meta.url));
const PINS = join(here, '..', 'src', 'uv-pins.ts');

function headers(extra = {}) {
  const h = { 'user-agent': 'bobble-pin-uv', ...extra };
  const token = process.env.GITHUB_TOKEN;
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

async function get(url, accept) {
  const res = await fetch(url, { headers: headers(accept ? { accept } : {}), redirect: 'follow' });
  if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status} ${res.statusText}`);
  return Buffer.from(await res.arrayBuffer());
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/** API digest `sha256:<hex>` → hex, or undefined when GitHub has none. */
function apiDigest(asset) {
  const d = asset?.digest;
  return typeof d === 'string' && d.startsWith('sha256:') ? d.slice(7).toLowerCase() : undefined;
}

/** Fetch a small release file and check it against the API's digest for it. */
async function releaseFile(release, name) {
  const asset = release.assets.find((a) => a.name === name);
  if (!asset) throw new Error(`release ${release.tag_name} has no ${name}`);
  const buf = await get(asset.browser_download_url);
  const want = apiDigest(asset);
  const got = sha256(buf);
  if (want !== undefined && want !== got) {
    throw new Error(`${name}: sha256 ${got} does not match the API digest ${want}`);
  }
  return { text: buf.toString('utf8'), sha256: got };
}

/** `<hex> *name` / `<hex>  name` lines → Map(name → hex). */
function parseSums(text) {
  const out = new Map();
  for (const line of text.split('\n')) {
    const m = /^([0-9a-f]{64})\s+\*?(\S+)\s*$/i.exec(line.trim());
    if (m) out.set(m[2], m[1].toLowerCase());
  }
  return out;
}

/**
 * The installer's `select_archive_for_arch` names, per glibc archive, the
 * oldest glibc it accepts: `_archive="uv-…-gnu.tar.gz"` then `check_glibc "2" "28"`.
 */
function parseMinGlibc(installer) {
  const out = new Map();
  const re = /_archive="(uv-[^"]+)"\s*\n\s*if ! check_glibc "(\d+)" "(\d+)"/g;
  for (let m = re.exec(installer); m !== null; m = re.exec(installer)) {
    const v = `${m[2]}.${m[3]}`;
    const prev = out.get(m[1]);
    if (prev !== undefined && prev !== v) {
      throw new Error(`installer disagrees with itself on ${m[1]}: ${prev} vs ${v}`);
    }
    out.set(m[1], v);
  }
  return out;
}

async function collect(version) {
  const release = JSON.parse(
    (
      await get(
        `https://api.github.com/repos/${REPO}/releases/tags/${version}`,
        'application/vnd.github+json',
      )
    ).toString('utf8'),
  );
  const sums = await releaseFile(release, 'sha256.sum');
  const installer = await releaseFile(release, 'uv-installer.sh');
  const bySum = parseSums(sums.text);
  const minGlibc = parseMinGlibc(installer.text);

  const assets = [];
  for (const a of release.assets) {
    const m = /^uv-(.+)\.(tar\.gz|zip)$/.exec(a.name);
    if (!m) continue;
    const fromSum = bySum.get(a.name);
    const fromApi = apiDigest(a);
    if (fromSum === undefined) throw new Error(`${a.name} is missing from sha256.sum`);
    if (fromApi !== undefined && fromApi !== fromSum) {
      throw new Error(`${a.name}: sha256.sum says ${fromSum}, the API says ${fromApi}`);
    }
    const target = m[1];
    const row = { target, assetName: a.name, sha256: fromSum, bytes: a.size };
    if (target.includes('-linux-gnu')) {
      const min = minGlibc.get(a.name);
      if (min !== undefined) row.minGlibc = min;
    }
    assets.push(row);
  }
  if (assets.length === 0) throw new Error(`release ${version} has no uv archives`);
  assets.sort((x, y) => (x.target < y.target ? -1 : x.target > y.target ? 1 : 0));
  return { version, assets, sumsSha256: sums.sha256, installerSha256: installer.sha256 };
}

function render({ version, assets, sumsSha256, installerSha256 }) {
  const rows = assets
    .map((a) => {
      const lines = [
        `    {`,
        `      target: '${a.target}',`,
        `      assetName: '${a.assetName}',`,
        `      sha256: '${a.sha256}',`,
        `      bytes: ${a.bytes},`,
      ];
      if (a.minGlibc !== undefined) lines.push(`      minGlibc: '${a.minGlibc}',`);
      lines.push(`    },`);
      return lines.join('\n');
    })
    .join('\n');
  return `/**
 * GENERATED by \`packages/web-tools/scripts/pin-uv.mjs\` — do not edit by hand.
 * Bump with \`node scripts/pin-uv.mjs <version>\`; CI runs \`--check\`.
 *
 * uv ${version}, every build the release publishes. Each sha256 comes from the
 * release's \`sha256.sum\` (sha256 ${sumsSha256})
 * and was required to equal GitHub's own digest for the asset. \`minGlibc\` is the
 * oldest glibc the release's \`uv-installer.sh\` (sha256 ${installerSha256})
 * accepts for that build.
 */
import type { UvPin } from './uv-platform.js';

export const PINNED_UV: UvPin = {
  version: '${version}',
  assets: [
${rows}
  ],
};
`;
}

async function pinnedVersion() {
  const text = await readFile(PINS, 'utf8');
  const m = /version: '([^']+)'/.exec(text);
  if (!m) throw new Error(`no version found in ${PINS}`);
  return { text, version: m[1] };
}

async function main() {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const explicit = args.find((a) => !a.startsWith('--'));

  if (check) {
    const { text, version } = await pinnedVersion();
    const want = render(await collect(version));
    if (want === text) {
      console.log(`uv ${version}: pins match upstream (${PINS})`);
      return;
    }
    const a = text.split('\n');
    const b = want.split('\n');
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i] !== b[i]) {
        console.error(
          `first difference at line ${i + 1}:\n  committed: ${a[i]}\n  upstream:  ${b[i]}`,
        );
        break;
      }
    }
    console.error(
      `uv ${version}: pins DIFFER from upstream — run: node scripts/pin-uv.mjs ${version}`,
    );
    process.exitCode = 1;
    return;
  }

  const version = explicit ?? (await pinnedVersion()).version;
  const data = await collect(version);
  await writeFile(PINS, render(data));
  console.log(`wrote ${PINS}: uv ${version}, ${data.assets.length} builds`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
