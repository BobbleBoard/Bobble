/**
 * EVERY DOWNLOAD, PINNED TO THE TOP BAR.
 *
 * the user: "pin this to the top bar easily cancellable from anywhere and
 * monitorable."
 *
 * A download is a background fact, not a page. Once you have started a 25 GB
 * fetch you go back to the chat, and until this existed the only way to see how
 * it was doing — or stop it — was to navigate back to the hub and find the row.
 * So the bar follows you: it appears in the top bar while anything is moving and
 * disappears when nothing is.
 *
 * IT SPANS BOTH DOWNLOADERS, because the user does not know there are two. A
 * GGUF comes from the inference supervisor and a repo from the store; here they
 * are just "the thing that is downloading", each with its own bar and its own X.
 *
 * WHAT IT DOES NOT DO is show a percentage or a filename. The top bar is not
 * where you study a transfer — it is where you notice one and stop it. The hub
 * still has the detail for when you want it.
 */
import type { JSX } from 'react';
import { downloadFraction, useLlmStore } from '../state/llm-store';
import { useStoreModels } from '../state/store-models';
import { DownloadBar } from './DownloadBar';

export function TopBarDownloads(): JSX.Element | null {
  const llm = useLlmStore((s) => s.download);
  const cancelLlm = useLlmStore((s) => s.cancelDownload);
  const storeProgress = useStoreModels((s) => s.progress);
  const cancelStore = useStoreModels((s) => s.cancel);

  const rows = [
    ...(llm === null
      ? []
      : [
          {
            key: `llm:${llm.modelId}`,
            name: llm.modelId,
            fraction: downloadFraction(llm),
            cancel: () => void cancelLlm(),
          },
        ]),
    ...Object.values(storeProgress).map((p) => ({
      key: `store:${p.repo}`,
      name: p.repo,
      // A repo reports 0 until its tree is listed; `null` draws the sweep, which
      // is the honest reading of "started, size not known yet".
      fraction: p.total > 0 ? p.fraction : null,
      cancel: () => void cancelStore(p.repo),
    })),
  ];

  if (rows.length === 0) return null;

  return (
    <div className="flex items-center gap-3" data-testid="topbar-downloads">
      {rows.map((row) => (
        <DownloadBar
          key={row.key}
          fraction={row.fraction}
          label={`Cancel ${row.name}`}
          testid={`topbar-download-${row.key}`}
          onCancel={row.cancel}
        />
      ))}
    </div>
  );
}
