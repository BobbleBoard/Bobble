/**
 * THE DOWNLOAD TRAY — top-left of the top bar, one icon for every download.
 *
 * the user (2026-09-13): "remove all progressbar and such from the input area,
 * move it up to the top bar in the hover/click to show. … move this to the
 * top left instead under a down arrow with half square outline below it, with
 * the progressbar and x inside it shown on click, show a tiny ! on the top
 * right of that icon when download finished."
 *
 * So: the icon appears while anything is downloading, or while there is news
 * (a download finished, or one that could not start — "Not enough space…");
 * a press opens the tray with each transfer's bar and X, its file and place in
 * the job, bytes, speed and time left, Pause/Resume; and the news, each with
 * a dismiss. The "!" sits on the icon until the tray has been opened once
 * since the news arrived. Nothing about a download is drawn anywhere else —
 * the composer's little bar is gone.
 *
 * It spans both downloaders (the inference supervisor for GGUFs, the store for
 * repos) because the user does not know there are two.
 */
import { IconButton, Popover, PopoverContent, PopoverTrigger } from '@pi-desktop/ui';
import { type JSX, useEffect, useState } from 'react';
import { IconDownloadTray } from '../settings/icons';
import { useDownloadTray } from '../state/download-tray';
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

function LlmRow({ d, name }: { d: LlmDownloadState; name: string }): JSX.Element {
  const pause = useLlmStore((s) => s.pauseDownload);
  const resume = useLlmStore((s) => s.resumeDownload);
  const cancel = useLlmStore((s) => s.cancelDownload);
  const total = d.jobTotal ?? d.total;
  const received =
    d.jobTotal !== null && d.jobTotal !== undefined ? (d.jobReceived ?? 0) : d.received;
  const eta = formatEta(downloadEtaSeconds(d));
  const known = total !== null && total !== undefined && total > 0;
  return (
    <div className="pd-tray-row" data-testid={`tray-row-llm:${d.modelId}`}>
      <div className="pd-tray-row-head">
        <span className="pd-tray-row-name">{name}</span>
        <span className="pd-tray-row-pct">{d.paused ? 'paused' : pctOf(downloadFraction(d))}</span>
      </div>
      <DownloadBar
        grow
        quiet
        fraction={downloadFraction(d)}
        received={received}
        total={total}
        eta={eta}
        label={`Cancel ${name}`}
        testid={`tray-download-llm:${d.modelId}`}
        onCancel={() => void cancel()}
      />
      <div className="pd-tray-row-sub">
        {d.file === '' ? 'starting…' : d.file}
        {d.fileCount !== undefined && d.fileCount > 1 && d.fileIndex !== undefined
          ? ` · ${d.fileIndex + 1} of ${d.fileCount}`
          : ''}
      </div>
      <div className="pd-tray-row-sub">
        {known
          ? `${compactBytes(received)} / ${compactBytes(total)}`
          : `${compactBytes(received)} so far`}
        {d.bytesPerSec !== null && d.bytesPerSec > 0 ? ` · ${compactBytes(d.bytesPerSec)}/s` : ''}
        {eta === '' ? '' : ` · ${eta}`}
      </div>
      <div className="pd-tray-row-actions">
        {d.paused ? (
          <button type="button" className="pd-engine-install" onClick={() => void resume()}>
            Resume
          </button>
        ) : (
          <button type="button" className="pd-engine-install" onClick={() => void pause()}>
            Pause
          </button>
        )}
      </div>
    </div>
  );
}

function StoreRow({
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
  const fraction = p.total > 0 ? p.fraction : null;
  return (
    <div className="pd-tray-row" data-testid={`tray-row-store:${p.repo}`}>
      <div className="pd-tray-row-head">
        <span className="pd-tray-row-name">{p.repo}</span>
        <span className="pd-tray-row-pct">{pctOf(fraction)}</span>
      </div>
      <DownloadBar
        grow
        quiet
        fraction={fraction}
        received={p.received}
        total={p.total > 0 ? p.total : null}
        label={`Cancel ${p.repo}`}
        testid={`tray-download-store:${p.repo}`}
        onCancel={onCancel}
      />
      <div className="pd-tray-row-sub">
        {p.file === '' ? 'listing the repo…' : p.file}
        {p.fileCount > 1 ? ` · ${p.fileIndex + 1} of ${p.fileCount}` : ''}
      </div>
      <div className="pd-tray-row-sub">
        {p.total > 0
          ? `${compactBytes(p.received)} / ${compactBytes(p.total)}`
          : `${compactBytes(p.received)} so far`}
      </div>
    </div>
  );
}

export function DownloadTray(): JSX.Element | null {
  const llm = useLlmStore((s) => s.download);
  const catalog = useLlmStore((s) => s.catalog);
  const storeProgress = useStoreModels((s) => s.progress);
  const cancelStore = useStoreModels((s) => s.cancel);
  const notices = useDownloadTray((s) => s.notices);
  const unseen = useDownloadTray((s) => s.unseen);
  const dismiss = useDownloadTray((s) => s.dismiss);
  const markSeen = useDownloadTray((s) => s.markSeen);
  const [open, setOpen] = useState(false);

  const active = (llm === null ? 0 : 1) + Object.keys(storeProgress).length;
  const show = active > 0 || notices.length > 0;
  // Nothing left to show closes the tray rather than leaving an empty panel up.
  useEffect(() => {
    if (!show) setOpen(false);
  }, [show]);
  if (!show) return null;

  const llmName =
    llm === null ? '' : (catalog.find((c) => c.id === llm.modelId)?.displayName ?? llm.modelId);
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) markSeen();
      }}
    >
      <PopoverTrigger asChild>
        <IconButton
          aria-label={
            active > 0
              ? `Downloads · ${active} in progress`
              : `Downloads · ${notices.length} to look at`
          }
          aria-pressed={open}
          title="Downloads"
          data-testid="download-tray"
          data-active={active}
          data-unseen={unseen ? 'yes' : 'no'}
          /* `no-drag`: the top bar is a window-drag region and macOS takes mouse
             events inside one before the renderer sees them. */
          className="[-webkit-app-region:no-drag] pd-tray-button"
        >
          <IconDownloadTray size={16} />
          {active > 0 ? <span className="pd-tray-dot" aria-hidden /> : null}
          {unseen && notices.length > 0 ? (
            <span
              className="pd-tray-badge"
              data-kind={notices[0]?.kind}
              data-testid="download-tray-badge"
              aria-hidden
            >
              !
            </span>
          ) : null}
        </IconButton>
      </PopoverTrigger>
      <PopoverContent
        className="pd-menu pd-tray-popover"
        side="bottom"
        align="start"
        sideOffset={6}
        data-testid="download-tray-panel"
      >
        {llm !== null ? <LlmRow d={llm} name={llmName} /> : null}
        {Object.values(storeProgress).map((p) => (
          <StoreRow key={p.repo} p={p} onCancel={() => void cancelStore(p.repo)} />
        ))}
        {notices.map((n) => (
          <div
            key={n.key}
            className="pd-tray-notice"
            data-kind={n.kind}
            data-testid={`tray-notice-${n.key}`}
          >
            <div className="pd-tray-notice-main">
              <span className="pd-tray-notice-title">
                {n.kind === 'finished' ? 'Finished' : 'Not downloaded'} · {n.name}
              </span>
              {n.detail !== undefined ? (
                <span className="pd-tray-notice-detail">{n.detail}</span>
              ) : null}
            </div>
            <button
              type="button"
              className="pd-tray-notice-x"
              aria-label={`Dismiss ${n.name}`}
              onClick={() => dismiss(n.key)}
            >
              ×
            </button>
          </div>
        ))}
        {active === 0 && notices.length === 0 ? (
          <div className="pd-tray-row-sub">No downloads.</div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
