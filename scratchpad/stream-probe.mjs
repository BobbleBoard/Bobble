// Spawns pi-mac --stream and prints one line per PIMF frame. Proves the
// framing and shows whether the Screen Recording grant is producing pixels.
import { spawn } from 'node:child_process';
const bin = 'packages/pi-mac/swift/.build/out/Products/Release/pi-mac';
const pid = process.argv[2];
const ms = Number(process.argv[3] ?? 4000);
const child = spawn(bin, ['--stream', '--pid', pid, '--fps', '8', '--max-width', '1200']);
let buf = Buffer.alloc(0);
let n = 0;
child.stdout.on('data', (d) => {
  buf = Buffer.concat([buf, d]);
  for (;;) {
    if (buf.length < 12) return;
    if (buf.subarray(0, 4).toString() !== 'PIMF') { console.log('DESYNC'); return; }
    const hLen = buf.readUInt32BE(4);
    const pLen = buf.readUInt32BE(8);
    if (buf.length < 12 + hLen + pLen) return;
    const header = JSON.parse(buf.subarray(12, 12 + hLen).toString());
    const payload = buf.subarray(12 + hLen, 12 + hLen + pLen);
    buf = buf.subarray(12 + hLen + pLen);
    n += 1;
    console.log(`frame ${header.seq} ${header.w ?? '-'}x${header.h ?? '-'} jpeg=${payload.length}B windows=${(header.windows ?? []).length} rect=${JSON.stringify(header.rect ?? null)}${header.empty ? ' EMPTY' : ''}`);
    if (n === 1 && payload.length > 0) {
      import('node:fs').then((fs) => fs.writeFileSync('scratchpad/stream-frame0.jpg', payload));
    }
  }
});
child.stderr.on('data', (d) => process.stderr.write(`[helper] ${d}`));
setTimeout(() => { child.stdin.write('{"cmd":"quit"}\n'); setTimeout(() => { console.log(`total frames: ${n}`); process.exit(0); }, 300); }, ms);
