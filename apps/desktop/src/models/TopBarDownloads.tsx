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
 * THE BAR IS CLICKABLE (the user, 2026-09-13: "show download progress in the top
 * bar clickable to show more details"): a press opens a small panel with the
 * model, the file moving now and its place in the job, bytes, percent, speed
 * and time left, and Pause / Resume / Cancel. The bar itself still shows no
 * numbers — it is where you notice a download, the panel is where you study
 * it.
 *
 * AND A REFUSAL IS SHOWN, not swallowed: when the last download did not start
 * (no room on the disk, a gated repo) a red chip takes the bar's place until
 * dismissed or the next attempt — the user: "does not download them or show any
 * user indication".
 */
import { Popover, PopoverAnchor, PopoverContent } from '@pi-desktop/ui';
import { type JSX, useState } from 'react';
import {
  downloadEtaSeconds,
  downloadFraction,
  formatEta,
  type LlmDownloadState,
  useLlmStore,
} from '../state/llm-store';
import { useStoreModels } from '../state/store-models';
import { DownloadBar } from './DownloadBar';
import { compactBytes } from './models-layout';

function pctOf(fraction: number | null): string {
  return fraction === null ? '' : `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
}

function LlmDetails({ d, name }: { d: LlmDownloadState; name: string }): JSX.Element {
  const pause = useLlmStore((s) => s.pauseDownload);
  const resume = useLlmStore((s) => s.resumeDownload);
  const cancel = useLlmStore((s) => s.cancelDownload);
  const total = d.jobTotal ?? d.total;
  const received =
    d.jobTotal !== null && d.jobTotal !== undefined ? (d.jobReceived ?? 0) : d.received;
  const eta = formatEta(downloadEtaSeconds(d));
  return (
    <div className="pd-dl-details" data-testid="topbar-download-details">
      <div className="pd-dl-details-title">{name}</div>
      <dl className="pd-dl-details-facts">
        <dt>File</dt>
        <dd>
          {d.file === '' ? 'starting…' : d.file}
          {d.fileCount !== undefined && d.fileCount > 1 && d.fileIndex !== undefined
            ? ` · ${d.fileIndex + 1} of ${d.fileCount}`
            : ''}
        </dd>
        <dt>Progress</dt>
        <dd>
          {total !== null && total !== undefined && total > 0
            ? `${compactBytes(received)} / ${compactBytes(total)} · ${pctOf(downloadFraction(d))}`
            : `${compactBytes(received)} so far`}
        </dd>
        {d.bytesPerSec !== null && d.bytesPerSec > 0 ? (
          <>
            <dt>Speed</dt>
            <dd>
              {compactBytes(d.bytesPerSec)}/s{eta === '' ? '' : ` · ${eta}`}
            </dd>
          </>
        ) : null}
        {d.paused ? (
          <>
            <dt>State</dt>
            <dd>paused</dd>
          </>
        ) : null}
      </dl>
      <div className="pd-dl-details-actions">
        {d.paused ? (
          <button type="button" className="pd-engine-install" onClick={() => void resume()}>
            Resume
          </button>
        ) : (
          <button type="button" className="pd-engine-install" onClick={() => void pause()}>
            Pause
          </button>
        )}
        <button
          type="button"
          className="pd-engine-install pd-dl-details-cancel"
          onClick={() => void cancel()}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function StoreDetails({
  p,
  onCancel,
}: {
  p: {
    repo: string;
    file: string;
    fileIndex: number;
    fileCount: number;
    received: number;
    total: number;
    fraction: number;
  };
  onCancel: () => void;
}): JSX.Element {
  return (
    <div className="pd-dl-details" data-testid="topbar-download-details">
      <div className="pd-dl-details-title">{p.repo}</div>
      <dl className="pd-dl-details-facts">
        <dt>File</dt>
        <dd>
          {p.file === '' ? 'listing the repo…' : p.file}
          {p.fileCount > 1 ? ` · ${p.fileIndex + 1} of ${p.fileCount}` : ''}
        </dd>
        <dt>Progress</dt>
        <dd>
          {p.total > 0
            ? `${compactBytes(p.received)} / ${compactBytes(p.total)} · ${pctOf(p.fraction)}`
            : `${compactBytes(p.received)} so far`}
        </dd>
      </dl>
      <div className="pd-dl-details-actions">
        <button type="button" className="pd-engine-install pd-dl-details-cancel" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

export function TopBarDownloads(): JSX.Element | null {
  const llm = useLlmStore((s) => s.download);
  const cancelLlm = useLlmStore((s) => s.cancelDownload);
  const catalog = useLlmStore((s) => s.catalog);
  const downloadError = useLlmStore((s) => s.downloadError);
  const clearDownloadError = useLlmStore((s) => s.clearDownloadError);
  const storeProgress = useStoreModels((s) => s.progress);
  const cancelStore = useStoreModels((s) => s.cancel);
  const [openKey, setOpenKey] = useState<string | null>(null);

  const llmName =
    llm === null ? '' : (catalog.find((c) => c.id === llm.modelId)?.displayName ?? llm.modelId);
  const rows: Array<{
    key: string;
    name: string;
    fraction: number | null;
    cancel: () => void;
    details: JSX.Element;
  }> = [
    ...(llm === null
      ? []
      : [
          {
            key: `llm:${llm.modelId}`,
            name: llmName,
            fraction: downloadFraction(llm),
            cancel: () => void cancelLlm(),
            details: <LlmDetails d={llm} name={llmName} />,
          },
        ]),
    ...Object.values(storeProgress).map((p) => ({
      key: `store:${p.repo}`,
      name: p.repo,
      // A repo reports 0 until its tree is listed; `null` draws the sweep, which
      // is the honest reading of "started, size not known yet".
      fraction: p.total > 0 ? p.fraction : null,
      cancel: () => void cancelStore(p.repo),
      details: <StoreDetails p={p} onCancel={() => void cancelStore(p.repo)} />,
    })),
  ];

  if (rows.length === 0) {
    if (downloadError === null) return null;
    const name =
      catalog.find((c) => c.id === downloadError.modelId)?.displayName ?? downloadError.modelId;
    return (
      <Popover open={openKey === 'error'} onOpenChange={(o) => setOpenKey(o ? 'error' : null)}>
        <PopoverAnchor asChild>
          <button
            type="button"
            className="[-webkit-app-region:no-drag] pd-dl-refusal pd-focusable"
            data-testid="topbar-download-error"
            title={downloadError.error}
            onClick={() => setOpenKey(openKey === 'error' ? null : 'error')}
          >
            {name} · not downloaded
          </button>
        </PopoverAnchor>
        <PopoverContent className="pd-menu pd-dl-popover" side="bottom" align="end" sideOffset={6}>
          <div className="pd-dl-details" data-testid="topbar-download-details">
            <div className="pd-dl-details-title">{name}</div>
            <p className="pd-dl-details-error">{downloadError.error}</p>
            <div className="pd-dl-details-actions">
              <button
                type="button"
                className="pd-engine-install"
                onClick={() => {
                  clearDownloadError();
                  setOpenKey(null);
                }}
              >
                Dismiss
              </button>
            </div>
          </div>
        </PopoverContent>
      </Popover>
    );
  }

  return (
    /* `no-drag`: the top bar is a window-drag region and macOS takes mouse
       events inside one before the renderer sees them — a bar in it would be
       neither clickable nor hoverable (see ChatApp's sidebar-toggle note). */
    <div
      className="[-webkit-app-region:no-drag] flex items-center gap-3"
      data-testid="topbar-downloads"
    >
      {rows.map((row) => (
        <Popover
          key={row.key}
          open={openKey === row.key}
          onOpenChange={(o) => setOpenKey(o ? row.key : null)}
        >
          <PopoverAnchor asChild>
            <span>
              <DownloadBar
                fraction={row.fraction}
                label={`Cancel ${row.name}`}
                testid={`topbar-download-${row.key}`}
                onCancel={row.cancel}
                onOpen={() => setOpenKey(openKey === row.key ? null : row.key)}
              />
            </span>
          </PopoverAnchor>
          <PopoverContent
            className="pd-menu pd-dl-popover"
            side="bottom"
            align="end"
            sideOffset={6}
          >
            {row.details}
          </PopoverContent>
        </Popover>
      ))}
    </div>
  );
}
