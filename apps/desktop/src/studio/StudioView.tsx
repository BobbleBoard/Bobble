/**
 * THE IMAGE & VIDEO STUDIO — primitive, and running on ComfyUI.
 *
 * the user: "let's have comfy as a downloadable inference engine and then wire up a
 * primitive for now image/video studio) and have those run through it."
 *
 * WHAT PRIMITIVE MEANS HERE. Pick a model you have downloaded, type a prompt,
 * press Generate, look at the result. No graph editor, no batching, no forty
 * samplers. That is not a placeholder for a real studio — it is the part of a
 * real studio that everything else is judged against, and it should work
 * completely before anything is stacked on it.
 *
 * THE GATES ARE THE INTERESTING PART, because there are two ways to have nothing
 * to run and they need different sentences. No ComfyUI is an engine problem and
 * the answer is Settings › Engines. No downloaded models of this kind is a
 * weights problem and the answer is the model hub. Saying "cannot generate"
 * without saying which would leave the user hunting.
 */
import { Button, IconChevronLeft, ScrollArea, Spinner } from '@pi-desktop/ui';
import { type JSX, useEffect, useMemo, useState } from 'react';
import type { StudioProgress, StudioStatus } from '../../electron/studio/studio-contract';
import { DownloadBar } from '../models/DownloadBar';
import { cx } from '../onboarding/cx';
import { exitModality } from '../state/modality-store';
import { useStoreModels } from '../state/store-models';

type Kind = 'image' | 'video';

export function StudioView(): JSX.Element {
  const [kind, setKind] = useState<Kind>('image');
  const [prompt, setPrompt] = useState('');
  const [status, setStatus] = useState<StudioStatus | null>(null);
  const [job, setJob] = useState<StudioProgress | null>(null);
  const [modelId, setModelId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const models = useStoreModels((s) => s.models);
  const refresh = useStoreModels((s) => s.refresh);

  useEffect(() => {
    void refresh();
    void window.piDesktop
      .invoke('studio:status', undefined)
      .then(setStatus)
      .catch(() => undefined);
  }, [refresh]);

  useEffect(() => {
    return window.piDesktop.onEvent('studio:progress', (p) => {
      setJob(p.phase === 'done' || p.phase === 'error' ? p : p);
      if (p.phase === 'error') setError(p.error ?? 'the generation failed');
    });
  }, []);

  /** What this machine can actually generate with, for this kind. */
  const usable = useMemo(
    () => models.filter((m) => m.kind === kind && m.incomplete !== true),
    [models, kind],
  );
  useEffect(() => {
    setModelId((cur) => (usable.some((m) => m.id === cur) ? cur : (usable[0]?.id ?? null)));
  }, [usable]);

  const busy = job !== null && (job.phase === 'starting' || job.phase === 'running');
  const outputs = job?.phase === 'done' ? (job.outputs ?? []) : [];

  const generate = async (): Promise<void> => {
    if (modelId === null || prompt.trim() === '') return;
    setError(null);
    setJob(null);
    const res = await window.piDesktop
      .invoke('studio:generate', { kind, prompt: prompt.trim(), modelId })
      .catch(() => null);
    if (res === null || res.ok !== true) setError(res?.error ?? 'could not start');
  };

  return (
    <div className="flex h-full flex-col bg-bg-base" data-testid="studio-view">
      {/* A full-window modality needs its own way out — the sidebar is not on
          screen here, so without this the studio is a room with no door. */}
      <div className="flex shrink-0 items-start gap-3 px-6 pt-3 pb-3">
        <button
          type="button"
          data-testid="studio-back"
          aria-label="Back to chat"
          onClick={() => exitModality()}
          className="pd-focusable mt-1 flex h-7 w-7 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
        >
          <IconChevronLeft size={16} />
        </button>
        <div>
          <h1 className="text-heading text-text-primary">Image &amp; Video Studio</h1>
          <p className="text-footnote text-text-muted">
            Images and video, generated on this machine with ComfyUI.
          </p>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-3 px-6 pb-4">
        <div className="flex rounded-full bg-bg-inset p-0.5" data-testid="studio-kind">
          {(['image', 'video'] as const).map((k) => (
            <button
              key={k}
              type="button"
              data-testid={`studio-kind-${k}`}
              aria-pressed={kind === k}
              onClick={() => setKind(k)}
              className={cx(
                'rounded-full px-3 py-1 text-footnote transition-colors',
                kind === k
                  ? 'bg-bg-raised text-text-primary shadow-[0_1px_2px_rgba(0,0,0,0.05)]'
                  : 'text-text-muted hover:text-text-primary',
              )}
            >
              {k === 'image' ? 'Image' : 'Video'}
            </button>
          ))}
        </div>
        {usable.length > 0 ? (
          <select
            data-testid="studio-model"
            value={modelId ?? ''}
            onChange={(e) => setModelId(e.target.value)}
            className="rounded-lg border border-border-subtle bg-bg-raised px-3 py-1.5 text-footnote text-text-primary"
          >
            {usable.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        ) : null}
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-4 px-6 pb-10">
          {/* GATE 1 — no engine. An engine problem, with an engine answer. */}
          {status !== null && !status.engineInstalled ? (
            <div
              className="rounded-xl border border-border-default bg-bg-raised p-4"
              data-testid="studio-needs-engine"
            >
              <p className="text-body text-text-primary">ComfyUI is not installed</p>
              <p className="mt-1 text-footnote text-text-muted">
                The studio runs image and video models on ComfyUI. Install it in Settings › Engines
                — about 6 GB, and every generation model then runs on it.
              </p>
            </div>
          ) : null}

          {/* GATE 2 — no weights of this kind. A different problem, different answer. */}
          {status?.engineInstalled === true && usable.length === 0 ? (
            <div
              className="rounded-xl border border-border-default bg-bg-raised p-4"
              data-testid="studio-needs-models"
            >
              <p className="text-body text-text-primary">No {kind} models downloaded yet</p>
              <p className="mt-1 text-footnote text-text-muted">
                Open Model management and download one — the hub says which ones this Mac can run
                before you spend the disk.
              </p>
            </div>
          ) : null}

          <div className="flex flex-col gap-2">
            <textarea
              data-testid="studio-prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={kind === 'image' ? 'Describe the image…' : 'Describe the shot…'}
              rows={3}
              className="w-full resize-y rounded-xl border border-border-subtle bg-bg-raised px-3 py-2 text-body text-text-primary placeholder:text-text-muted"
            />
            <div className="flex items-center gap-3">
              <Button
                variant="accent"
                size="sm"
                data-testid="studio-generate"
                disabled={busy || modelId === null || prompt.trim() === ''}
                onClick={() => void generate()}
              >
                Generate
              </Button>
              {busy ? (
                <DownloadBar
                  fraction={job?.fraction ?? null}
                  label="Cancel generation"
                  testid="studio-progress"
                  onCancel={() =>
                    void window.piDesktop.invoke('studio:cancel', { jobId: job?.jobId ?? '' })
                  }
                />
              ) : null}
              {job?.phase === 'starting' ? (
                <span className="flex items-center gap-2 text-footnote text-text-muted">
                  <Spinner size={12} /> Starting ComfyUI…
                </span>
              ) : null}
            </div>
            {error !== null ? (
              <p className="text-footnote text-status-danger-fg" data-testid="studio-error">
                {error}
              </p>
            ) : null}
          </div>

          {outputs.length > 0 ? (
            <div className="grid grid-cols-2 gap-3" data-testid="studio-outputs">
              {outputs.map((file) =>
                /\.(mp4|webm|mov)$/i.test(file) ? (
                  // biome-ignore lint/a11y/useMediaCaption: a generated clip has no captions
                  <video
                    key={file}
                    src={`pd-file://${file}`}
                    controls
                    className="w-full rounded-xl border border-border-subtle"
                  />
                ) : (
                  <img
                    key={file}
                    src={`pd-file://${file}`}
                    alt={prompt}
                    className="w-full rounded-xl border border-border-subtle"
                  />
                ),
              )}
            </div>
          ) : null}
        </div>
      </ScrollArea>
    </div>
  );
}
