/**
 * THE REPO CARD — a Hugging Face model OR dataset README, for the hub's detail
 * pane.
 *
 * The user: "ensure you're rendering the model card/readme as nicely as unsloth
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

/**
 * A dataset repo lives in its own namespace on the Hub. Asking the model path
 * for a dataset's card does not 404 politely — it 401s, which reads as "gated"
 * and sends the user off hunting for a token they do not need.
 */
function repoBase(repoId: string, kind: 'model' | 'dataset'): string {
  return kind === 'dataset'
    ? `https://huggingface.co/datasets/${repoId}`
    : `https://huggingface.co/${repoId}`;
}

/** `./assets/x.png` means nothing here; make it point at the repo. */
function absolutiseAssets(md: string, repoId: string, kind: 'model' | 'dataset'): string {
  const base = `${repoBase(repoId, kind)}/resolve/main/`;
  return md.replace(/(!\[[^\]]*\]\()(?!https?:|data:)\.?\/?([^)\s]+)/g, (_m, head, rel) => {
    return `${head}${base}${rel}`;
  });
}

export async function fetchModelCard(
  repoId: string,
  kind: 'model' | 'dataset' = 'model',
): Promise<{ markdown?: string; error?: string }> {
  // The namespace is part of the identity: `wikitext` exists as both.
  const key = `${kind}:${repoId}`;
  const cached = cache.get(key);
  if (cached !== undefined) return { markdown: cached };
  try {
    const res = await fetch(`${repoBase(repoId, kind)}/raw/main/README.md`, {
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) {
      // 404 is ordinary: plenty of repos have no card. Say so plainly rather
      // than showing an error box for a normal state.
      const noun = kind === 'dataset' ? 'dataset' : 'model';
      return { error: res.status === 404 ? `This ${noun} has no card.` : `HTTP ${res.status}` };
    }
    const raw = await res.text();
    let md = absolutiseAssets(stripHtmlComments(stripFrontmatter(raw)).trim(), repoId, kind);
    if (md.length > MAX_CHARS) md = `${md.slice(0, MAX_CHARS)}\n\n…card truncated.`;
    cache.set(key, md);
    return { markdown: md };
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'could not fetch the model card' };
  }
}

/*
 * NO HANDLER MAP HERE.
 *
 * This file used to export one, and nothing imported it — llm-main.ts declares
 * its own `modelCardHandlers` and that is the one actually registered. Two maps
 * with the same name meant editing the wrong one looked correct and changed
 * nothing: `kind` was threaded through the dead copy while every real request
 * still went to the model namespace. One registration, in the file that does
 * the registering.
 */
