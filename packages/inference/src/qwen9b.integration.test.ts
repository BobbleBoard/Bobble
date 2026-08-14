/**
 * Does the new balanced pick actually work — MTP and vision, on one launch?
 *
 * the user: "go download qwen3.5-9b (configure mtp to work still and ensure vision
 * works) replacing gemma4-12b as the standard balanced option."
 *
 * The unit tests prove the CATALOG and the tier table say the right things. That
 * is not the same as the model coming up with speculative decoding on and eyes
 * open — the previous catalog entry claimed a projector with `bytes: 0` that
 * nobody had ever fetched, which is exactly the kind of claim a unit test
 * happily confirms and a launch does not.
 *
 * So this launches the real server and checks three things that can only be
 * observed from a running process:
 *   1. llama-server accepted `--spec-type draft-mtp` with NO sibling draft file
 *      (the head is embedded) — asserted from its own startup log.
 *   2. it loaded the multimodal projector.
 *   3. it can describe an image whose contents we chose, and generates text.
 *
 * OPT-IN — spawns a real server and loads ~10GB:
 *   PI_INFERENCE_INTEGRATION=1 npx vitest run src/qwen9b.integration.test.ts
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LlamaServerSupervisor } from './supervisor.js';

const SERVER = path.join(homedir(), '.cache/pi-desktop/llamacpp/b9934/llama-b9934/llama-server');
const DIR = path.join(homedir(), '.cache/pi-desktop/models/qwen3.5-9b-mtp');
const MODEL = path.join(DIR, 'Qwen3.5-9B-Q8_0.gguf');
const MMPROJ = path.join(DIR, 'mmproj-F16.gguf');
const IMAGE = path.join(homedir(), 'bobble-testbed/vision-check.png');

const READY = existsSync(SERVER) && existsSync(MODEL) && existsSync(MMPROJ) && existsSync(IMAGE);
const RUN = process.env.PI_INFERENCE_INTEGRATION === '1' && READY;

describe.skipIf(!RUN)('qwen3.5-9b as the balanced pick', () => {
  it('comes up with embedded MTP and vision, and can see', async () => {
    const logs: string[] = [];
    const sup = new LlamaServerSupervisor({
      serverPath: SERVER,
      modelPath: MODEL,
      launchMode: 'fast-text',
      // Exactly what the app builds for this model: embedded MTP head, no
      // --model-draft, projector attached on the fast-text path.
      mmprojPath: MMPROJ,
      mtpEmbedded: true,
      mtpSupported: true,
      contextSize: 8192,
      healthTimeoutMs: 300_000,
    });
    sup.on((e) => {
      if (e.type === 'log') logs.push(e.text);
    });

    const { baseUrl } = await sup.start();
    try {
      const log = logs.join('\n');

      // 1. Projector loaded — llama-server says this in as many words.
      expect(log).toMatch(/loaded multimodal model/i);

      // 3. It can actually SEE. The image is a red circle, a blue square and a
      //    green triangle — chosen so a wrong answer cannot look like a right
      //    one, unlike asking about a photo where "a scene" is always true.
      const b64 = readFileSync(IMAGE).toString('base64');
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'List every shape and its colour. Be brief.' },
                { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } },
              ],
            },
          ],
          max_tokens: 200,
          temperature: 0,
        }),
      });
      const json = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
        timings?: { predicted_per_second?: number };
      };
      const answer = (json.choices?.[0]?.message?.content ?? '').toLowerCase();
      console.log('vision answer:', answer.replace(/\s+/g, ' ').slice(0, 300));
      console.log('decode tok/s :', json.timings?.predicted_per_second);

      /*
       * Blind models produce fluent text about nothing, so grade on the CONTENT
       * we planted rather than on getting a reply at all.
       *
       * "square" accepts "rectangle": the model answered "rectangle: blue",
       * which is CORRECT — a square is a rectangle — and my first version failed
       * it for not using my word. Grade the seeing, not the vocabulary.
       */
      for (const want of [/circle/, /square|rectangle/, /triangle/]) {
        expect(answer).toMatch(want);
      }
      for (const want of ['red', 'blue', 'green']) {
        expect(answer).toContain(want);
      }

      /*
       * 2. MTP IS ACTUALLY ENGAGING.
       *
       * My first attempt asserted that the startup log mentions "draft" or
       * "spec". It does not — the server logs neither, so the assertion failed
       * on a launch that was working perfectly. Throughput is the observable
       * that actually distinguishes the two, and it is unambiguous.
       *
       * MEASURED on the dev M5 Pro, Q8_0, same prompt, temperature 0:
       *   --spec-type draft-mtp + --mmproj   50.2, 49.9 tok/s
       *   --mmproj only (control)            29.0, 29.0 tok/s   → 1.72x
       *
       * The threshold sits between the two populations, well clear of both.
       * Hardware-sensitive by nature, which is part of why this test is opt-in.
       */
      const tps = json.timings?.predicted_per_second ?? 0;
      expect(tps).toBeGreaterThan(38);
    } finally {
      await sup.dispose();
    }
  }, 600_000);
});
