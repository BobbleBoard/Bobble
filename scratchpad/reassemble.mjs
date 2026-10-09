/** Rebuild an existing run's MP4 from its frames, at real time. */
import { execFile } from 'node:child_process';
import { readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');
const run = promisify(execFile);
const OUT = `${REPO_ROOT}/scratchpad/demos`;
for (const name of process.argv.slice(2)) {
  const dir = path.join(OUT, name, 'frames');
  const frames = readdirSync(dir)
    .filter((f) => f.endsWith('.jpg') || f.endsWith('.png'))
    .sort()
    .map((f) => ({
      file: path.join(dir, f),
      t: Number(f.split('-')[2]?.replace(/\.\w+$/, '') ?? 0),
    }));
  if (frames.length === 0) continue;
  const lines = [];
  for (let i = 0; i < frames.length; i += 1) {
    const next = frames[i + 1]?.t ?? frames[i].t + 33;
    lines.push(
      `file '${frames[i].file}'`,
      `duration ${Math.min(3, Math.max(0.004, (next - frames[i].t) / 1000)).toFixed(3)}`,
    );
  }
  lines.push(`file '${frames[frames.length - 1].file}'`);
  const list = path.join(OUT, name, 'frames.txt');
  writeFileSync(list, lines.join('\n'));
  const video = path.join(OUT, name, `${name}.mp4`);
  await run('ffmpeg', [
    '-y',
    '-loglevel',
    'error',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    list,
    '-vf',
    'scale=trunc(iw/2)*2:trunc(ih/2)*2,fps=30',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-preset',
    'veryfast',
    '-crf',
    '20',
    video,
  ]);
  const real = (frames[frames.length - 1].t - frames[0].t) / 1000;
  const vid = lines
    .filter((l) => l.startsWith('duration '))
    .reduce((a, l) => a + Number(l.split(' ')[1]), 0);
  console.log(
    `${name}: ${frames.length} frames, real ${real.toFixed(1)}s → video ${vid.toFixed(1)}s (${(vid / real).toFixed(2)}x)`,
  );
}
