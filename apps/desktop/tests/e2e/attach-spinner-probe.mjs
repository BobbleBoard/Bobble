/**
 * THE ATTACHMENT SPINNER SURVIVES SEND — and still knows how to stop.
 *
 * the user: "we also want loading on attachments as they are tokenized and prefilled
 * (while we are still typing our prompt) they stop loading maybe even after
 * sent, the loading spinner can still be on them, it disapears when they are
 * prefilled."
 *
 * The composer half already worked. The chips LEAVE the composer with the
 * message, and the copies rendered in the thread carried no prefill state at
 * all, so the spinner vanished at the exact moment the wait became real.
 *
 * This drives the three states through the real store and LOOKS at each:
 *
 *   1. sent, prompt still being read      → spinner on the chip
 *   2. the first token has landed         → spinner gone
 *   3. a chat REOPENED from disk, with a flag still raised → no spinner,
 *      because an indicator that never clears is worse than none
 *
 * Invisible (harness.mjs).
 */
import { launchApp } from './harness.mjs';

const { page, shot, check, finish } = await launchApp('attach-spinner');
await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 20_000 });

/**
 * A user turn carrying a folded attachment, exactly as `buildAgentMessage`
 * writes it — the thread unfolds `agentText`, so anything else would render as
 * prose rather than as a card.
 */
const PASTE = `Wall notes.\n${'The overhang runs twelve metres and the holds are spaced widely. '.repeat(
  12,
)}`;

/** Put the thread into one of the three states and read back what it drew. */
const setThread = (state) =>
  page.evaluate(
    ({ state, paste }) => {
      const folded = `Attached file \`pasted content\`:\n\`\`\`\n${paste}\n\`\`\`\n\nHow wide is the wall?`;
      const messages = [
        {
          kind: 'user',
          id: 'u1',
          text: 'How wide is the wall?',
          agentText: folded,
          timestamp: 1,
        },
      ];
      if (state === 'answered') {
        messages.push({
          kind: 'assistant',
          id: 'a1',
          timestamp: 2,
          isStreaming: false,
          blocks: [{ type: 'text', text: 'Twelve metres.' }],
        });
      }
      if (state === 'firstToken') {
        messages.push({
          kind: 'assistant',
          id: 'a1',
          timestamp: 2,
          isStreaming: true,
          blocks: [{ type: 'text', text: 'Twelve' }],
        });
      }
      window.__pi_store().setState({
        messages,
        // Raised by the dispatch bridge on send — and, notoriously, by the model
        // warm-up, which is the case state 3 exists to prove is handled.
        promptInFlight: state !== 'firstToken',
        agent: { ...window.__pi_store().getState().agent, isStreaming: state === 'firstToken' },
      });
    },
    { state, paste: PASTE },
  );

const read = () =>
  page.evaluate(() => {
    const row = document.querySelector('[data-testid="user-attachments"]');
    return {
      cards: row?.querySelectorAll('.pd-pasted').length ?? 0,
      spinners: row?.querySelectorAll('[data-testid="attach-prefilling"]').length ?? 0,
      // The thread's own processing indicator, for the same turn — the two read
      // the same phase, so they must agree.
      ring: document.querySelector('[data-testid="thread-processing"]') !== null,
    };
  });

// ── 1. Just sent: the model is still reading the file ────────────────────
await setThread('sending');
await page.waitForTimeout(900);
const sending = await read();
console.log('sent, still prefilling:', JSON.stringify(sending));
await shot('01-sent-prefilling');
check(sending.cards === 1, `the attachment did not render as a card (${sending.cards})`);
check(sending.spinners === 1, 'the chip on the just-sent message has no spinner');

// ── 2. The first token lands ─────────────────────────────────────────────
await setThread('firstToken');
await page.waitForTimeout(900);
const answering = await read();
console.log('first token in:', JSON.stringify(answering));
await shot('02-first-token');
check(answering.cards === 1, 'the card vanished with the spinner');
check(answering.spinners === 0, 'the spinner is still up after the turn started producing');

// ── 3. A chat reopened from disk, with a flag nobody cleared ─────────────
await setThread('answered');
await page.waitForTimeout(900);
const restored = await read();
console.log('reopened chat:', JSON.stringify(restored));
await shot('03-reopened-chat');
check(restored.cards === 1, 'the card is missing on a restored chat');
check(
  restored.spinners === 0,
  'a reopened chat spins forever about a turn that was answered long ago',
);

await finish();
