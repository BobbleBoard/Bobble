/**
 * Grade a bench run from the ARTIFACTS, not from the transcript.
 *
 * A model that writes a confident paragraph and no file has failed the task, and
 * a model that writes a file full of placeholders has failed it too. Every check
 * here is something you can point at in the output: the file exists, it contains
 * the structure the prompt demanded, and it contains the specific researched
 * VALUES the prompt demanded — which is the part that separates "produced HTML"
 * from "did the job".
 *
 *   DIR   folder the run wrote into   (required)
 *   OUT   where to write grade.json   (required)
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const DIR = process.env.DIR;
const OUT = process.env.OUT;
if (DIR === undefined || OUT === undefined) {
  console.error('bench-grade: DIR and OUT are required');
  process.exit(2);
}
mkdirSync(OUT, { recursive: true });

const read = (rel) => {
  const p = path.join(DIR, rel);
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
};
const has = (s, re) => (s === null ? false : typeof re === 'string' ? s.includes(re) : re.test(s));
const near = (s, re, want, tol) => {
  if (s === null) return false;
  for (const m of s.matchAll(re)) {
    const v = Number(String(m[1]).replace(/,/g, ''));
    if (Number.isFinite(v) && Math.abs(v - want) <= tol) return true;
  }
  return false;
};

const CHECKS = [
  {
    id: 'moons-table',
    file: 'moons.html',
    checks: (s) => [
      ['is a table', has(s, /<table/i)],
      [
        'names five moons',
        ['Titan', 'Rhea', 'Iapetus', 'Dione', 'Tethys'].filter((m) => has(s, m)).length >= 5,
      ],
      ['Titan diameter ~5149 km', near(s, /([\d,]{4,6})/g, 5149, 40)],
      ['has discovery years', has(s, /1[6-8]\d\d/)],
    ],
  },
  {
    id: 'solar-chart',
    file: 'solar.html',
    checks: (s) => [
      ['inline SVG', has(s, /<svg/i)],
      ['no CDN', !has(s, /<script[^>]+src="https?:/i) && !has(s, /<link[^>]+href="https?:/i)],
      [
        'six countries',
        [
          'China',
          'United States',
          'India',
          'Japan',
          'Germany',
          'Brazil',
          'Spain',
          'Australia',
          'Italy',
        ].filter((c) => has(s, c)).length >= 6,
      ],
      ['GW figures', has(s, /\d\s?GW/i)],
      ['names the year', has(s, /20[12]\d/)],
    ],
  },
  {
    id: 'http3-deck',
    file: 'deck.html',
    checks: (s) => [
      ['six slides', (s?.match(/class="[^"]*slide/gi) ?? []).length >= 6],
      ['arrow-key nav', has(s, /ArrowRight/) && has(s, /ArrowLeft/)],
      ['an SVG diagram', has(s, /<svg/i)],
      ['mentions QUIC', has(s, /QUIC/i)],
    ],
  },
  {
    id: 'llm-compare',
    file: 'models.html',
    checks: (s) => [
      ['is a table', has(s, /<table/i)],
      ['five models', (s?.match(/<tr/gi) ?? []).length >= 6],
      ['licences', has(s, /licen[cs]e/i)],
      ['context windows', has(s, /\d{2,3}[Kk]\b|\d{4,7}\s*(tokens)?/)],
      ['says which is smallest', has(s, /smallest/i)],
    ],
  },
  {
    id: 'apollo-timeline',
    file: 'apollo.html',
    checks: (s) => [
      [
        'all seven missions',
        [11, 12, 13, 14, 15, 16, 17].filter((n) => has(s, `Apollo ${n}`)).length === 7,
      ],
      ['crew names', has(s, /Armstrong/) && has(s, /Lovell/)],
      ['filter buttons', (s?.match(/<button/gi) ?? []).length >= 2],
      ['wired up', has(s, /addEventListener|onclick/i)],
      [
        'Apollo 13 is the non-landing',
        has(s, /13/) && has(s, /did ?-?not ?-?land|aborted|no landing/i),
      ],
    ],
  },
  {
    id: 'population-dash',
    file: 'population.html',
    checks: (s) => [
      ['three tiles', (s?.match(/class="[^"]*(tile|stat|card)/gi) ?? []).length >= 3],
      ['SVG line chart', has(s, /<svg/i) && has(s, /<(polyline|path)/i)],
      [
        '1950 ~2.5bn',
        near(s, /([\d.,]+)\s*(?:billion|bn)/gi, 2.5, 0.25) ||
          near(s, /(2[,.]5\d{2}[,.]?\d*)/g, 2500, 200),
      ],
      [
        '2020 ~7.8bn',
        near(s, /([\d.,]+)\s*(?:billion|bn)/gi, 7.8, 0.3) ||
          near(s, /(7[,.]7\d{2}[,.]?\d*)/g, 7800, 300),
      ],
      ['the multiple', has(s, /3\.\d|×|x\b/)],
    ],
  },
  {
    id: 'bloom-filter',
    file: 'bloom.html',
    checks: (s) => [
      ['inputs', (s?.match(/<input/gi) ?? []).length >= 2],
      ['wired up', has(s, /addEventListener|onclick/i)],
      ['renders the bit array', has(s, /bit/i)],
      ['false-positive maths', has(s, /1\s*-\s*e|\(1\s*-\s*1\s*\/\s*m|Math\.pow|\*\*/)],
      ['names its k', has(s, /\bk\b/) && has(s, /hash/i)],
    ],
  },
  {
    id: 'vector-search',
    file: 'vectors.html',
    checks: (s) => [
      ['is a table', has(s, /<table/i)],
      ['all three', ['HNSW', 'IVF', 'ScaNN'].filter((n) => has(s, n)).length === 3],
      ['complexity notation', has(s, /O\(/)],
      ['a recommendation', has(s, /recommend/i)],
    ],
  },
  {
    id: 'osi-site',
    dir: 'osi',
    checks: (_s, files) => [
      [
        'three pages',
        ['index.html', 'lower.html', 'upper.html'].filter((f) => files.includes(f)).length === 3,
      ],
      ['a shared stylesheet', files.some((f) => f.endsWith('.css'))],
      ['links between pages', has(read('osi/index.html'), /href="(lower|upper)\.html"/)],
      [
        'seven layers on the index',
        [
          'Physical',
          'Data Link',
          'Network',
          'Transport',
          'Session',
          'Presentation',
          'Application',
        ].filter((l) => has(read('osi/index.html'), l)).length === 7,
      ],
      ['TCP is in lower.html', has(read('osi/lower.html'), /TCP/)],
    ],
  },
  {
    id: 'co2-analysis',
    file: 'co2.html',
    checks: (s) => [
      ['SVG line chart', has(s, /<svg/i) && has(s, /<(polyline|path)/i)],
      ['no runtime fetch', !has(s, /fetch\(|XMLHttpRequest/)],
      ['1960 ~316.9 ppm', near(s, /(3[01]\d(?:\.\d+)?)/g, 316.9, 2)],
      ['2020 ~414.2 ppm', near(s, /(41\d(?:\.\d+)?)/g, 414.2, 2)],
      ['two paragraphs', (s?.match(/<p[\s>]/gi) ?? []).length >= 2],
      ['an annual rate', has(s, /per year|annual|\/yr|ppm\/y/i)],
    ],
  },
];

const rows = [];
for (const c of CHECKS) {
  let body = null;
  let files = [];
  if (c.file !== undefined) body = read(c.file);
  if (c.dir !== undefined) {
    try {
      files = readdirSync(path.join(DIR, c.dir));
    } catch {}
  }
  const present = c.file !== undefined ? body !== null : files.length > 0;
  const results = present ? c.checks(body, files) : [];
  const passed = results.filter(([, ok]) => ok).length;
  rows.push({
    id: c.id,
    produced: present,
    bytes: body === null ? 0 : body.length,
    passed,
    total: present ? results.length : c.checks(null, []).length,
    detail: results.map(([name, ok]) => ({ name, ok })),
  });
}

writeFileSync(path.join(OUT, 'grade.json'), JSON.stringify(rows, null, 2));
for (const r of rows) {
  const bar = r.produced ? `${r.passed}/${r.total}` : 'NO FILE';
  console.log(`${r.id.padEnd(18)} ${bar.padEnd(9)} ${r.bytes ? `${r.bytes}B` : ''}`);
  for (const d of r.detail) if (!d.ok) console.log(`    miss: ${d.name}`);
}
const produced = rows.filter((r) => r.produced).length;
const score = rows.reduce((a, r) => a + r.passed, 0);
const outOf = rows.reduce((a, r) => a + r.total, 0);
console.log(`\nartifacts ${produced}/10 · checks ${score}/${outOf}`);
