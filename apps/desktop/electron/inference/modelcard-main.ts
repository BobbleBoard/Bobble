/**
 * THE MODEL CARD — a Hugging Face repo's README, for the hub's detail pane.
 *
 * the user: "ensure you're rendering the model card/readme as nicely as unsloth
 * does". The reference gives most of its detail pane to the rendered card;
 * ours was ~87% empty space.
 *
 * Main fetches it because the renderer cannot: the app's CSP is `connect-src
 * 'self' blob: pd-file:`, which is deliberate — the UI does not reach the
 * network, main does.
 *
 * Three things it does to the raw file, all so the pane shows a document rather
 * than a dump:
 *   - strips the YAML frontmatter, which is metadata for the Hub and reads as
 *     noise at the top of a card
 *   - caps the size, because some cards are enormous and a detail pane is not
 *     a document viewer
 *   - rewrites relative image paths to absolute ones, since a card written for
 *     huggingface.co is full of `./assets/x.png` that resolve to nothing here
 *   - strips HTML comments. Quantisers put their build metadata in them
 *     (`<!-- ### quantize_version: 2 -->`), and a markdown renderer that does
 *     not process raw HTML prints them as prose — MEASURED: the top of one card
 *     was four lines of literal comment markers before any real text.
 */
import type { ModelCardInvokeMap } from '../ipc-contract';

const MAX_CHARS = 60_000;
const cache = new Map<string, string>();

/** Build metadata hidden in comments is not prose either. */
function stripHtmlComments(md: string): string {
  return md.replace(/<!--[\s\S]*?-->/g, '');
}

/** Frontmatter is Hub metadata, not prose. */
function stripFrontmatter(md: string): string {
  if (!md.startsWith('---')) return md;
  const end = md.indexOf('\n---', 3);
  return end === -1 ? md : md.slice(md.indexOf('\n', end + 1) + 1);
}

/** `./assets/x.png` means nothing here; make it point at the repo. */
function absolutiseAssets(md: string, repoId: string): string {
  const base = `https://huggingface.co/${repoId}/resolve/main/`;
  return md.replace(/(!\[[^\]]*\]\()(?!https?:|data:)\.?\/?([^)\s]+)/g, (_m, head, rel) => {
    return `${head}${base}${rel}`;
  });
}

export async function fetchModelCard(
  repoId: string,
): Promise<{ markdown?: string; error?: string }> {
  const cached = cache.get(repoId);
  if (cached !== undefined) return { markdown: cached };
  try {
    const res = await fetch(`https://huggingface.co/${repoId}/raw/main/README.md`, {
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) {
      // 404 is ordinary: plenty of repos have no card. Say so plainly rather
      // than showing an error box for a normal state.
      return { error: res.status === 404 ? 'This model has no card.' : `HTTP ${res.status}` };
    }
    const raw = await res.text();
    let md = absolutiseAssets(stripHtmlComments(stripFrontmatter(raw)).trim(), repoId);
    if (md.length > MAX_CHARS) md = `${md.slice(0, MAX_CHARS)}\n\n…card truncated.`;
    cache.set(repoId, md);
    return { markdown: md };
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'could not fetch the model card' };
  }
}

export const modelCardHandlers = {
  'modelcard:fetch': (req: { repoId: string }) => fetchModelCard(req.repoId),
} satisfies { [K in keyof ModelCardInvokeMap]: unknown };
