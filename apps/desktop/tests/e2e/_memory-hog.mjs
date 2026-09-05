/**
 * A DESIGNATED VICTIM — a process whose whole job is to make the machine tight.
 *
 * Used by power-stress-probe to create REAL memory pressure rather than a
 * simulated reading, because the whole question the user asked is what the policy
 * does when the machine is actually struggling, and a stubbed sysctl cannot
 * answer that.
 *
 * Three properties make it safe to point at somebody's working machine:
 *
 *   IT HOLDS MEMORY THAT CANNOT BE COMPRESSED AWAY. The first version touched
 *   one byte per 4 KB page, on the reasoning that a page written is a page
 *   resident. MEASURED: it held "6 GB" while the OS's free-memory percentage did
 *   not move past 39% — because a page of zeros with one byte set compresses
 *   ~100:1, and macOS's compressor simply ate the lot. Each chunk is filled with
 *   random bytes now, which nothing can squash.
 *
 *   IT ONLY GROWS WHEN TOLD. The parent watches pressure between chunks and asks
 *   for the next one, so the ramp stops the instant the OS says critical instead
 *   of running to jetsam.
 *
 *   IT LETS GO OF EVERYTHING. `release` drops the references and the process
 *   exits on its own if the parent dies (stdin close), so a probe that crashes
 *   cannot leave gigabytes pinned.
 */
import { randomFillSync } from 'node:crypto';

const chunks = [];
const CHUNK_BYTES = 256 * 1024 * 1024;
/** randomFillSync caps at 2^31-1 per call, and smaller passes are kinder. */
const FILL_SLICE = 32 * 1024 * 1024;

process.stdin.setEncoding('utf8');
process.stdin.on('data', (line) => {
  for (const cmd of String(line).trim().split('\n')) {
    if (cmd === 'grow') {
      try {
        const buf = Buffer.allocUnsafe(CHUNK_BYTES);
        // Random, so the compressor cannot give the memory back behind our back.
        for (let off = 0; off < buf.length; off += FILL_SLICE) {
          randomFillSync(buf, off, Math.min(FILL_SLICE, buf.length - off));
        }
        chunks.push(buf);
        process.stdout.write(`held ${chunks.length}\n`);
      } catch {
        // Out of address space / refused: say so rather than dying silently.
        process.stdout.write(`refused ${chunks.length}\n`);
      }
    } else if (cmd === 'release') {
      chunks.length = 0;
      if (typeof global.gc === 'function') global.gc();
      process.stdout.write('released\n');
    } else if (cmd === 'bye') {
      process.exit(0);
    }
  }
});
// The parent dying takes this with it — nothing stays pinned.
process.stdin.on('end', () => process.exit(0));
process.stdout.write('ready\n');
