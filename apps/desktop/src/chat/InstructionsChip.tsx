/**
 * "The model was also told this" — the AGENTS.md chain, made visible.
 *
 * The model reads a project's instruction files on every turn, and the app
 * showed nothing about which ones. So "why did it do that" had an answer sitting
 * on disk that nothing in the UI would surface, and a user who wrote an
 * AGENTS.md had no way to confirm it was picked up — the failure mode is
 * silence, which is the hardest one to debug.
 *
 * SIZES AND PATHS, NOT CONTENTS. The point is "these are in effect, here is
 * where they live"; the app can already open a path, and re-rendering the file
 * inside a chip would be a second copy that can go stale.
 *
 * Absent when there are none. A chip reading "0 instruction files" is a control
 * that exists to say nothing.
 */

import { IconFolder, Tooltip } from '@pi-desktop/ui';
import { type JSX, useEffect, useState } from 'react';
import { usePiStore } from '../state/pi-slice';

interface InstructionFile {
  readonly path: string;
  /** The path with `~` collapsed. Main knows HOME; the renderer does not. */
  readonly label: string;
  readonly bytes: number;
}

/** `12.4 KB` / `840 B` — small enough to read at a glance. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
}

export function summarise(files: readonly InstructionFile[]): string {
  return files.map((f) => `${f.label} · ${formatBytes(f.bytes)}`).join('\n');
}

export function InstructionsChip(): JSX.Element | null {
  const cwd = usePiStore((s) => s.session?.cwd);
  const [files, setFiles] = useState<InstructionFile[]>([]);

  useEffect(() => {
    if (cwd === undefined || cwd === '') {
      setFiles([]);
      return;
    }
    let cancelled = false;
    void window.piDesktop
      .invoke('fs:project-instructions', { cwd })
      .then((res) => {
        if (!cancelled) setFiles(res.files);
      })
      .catch(() => {
        if (!cancelled) setFiles([]);
      });
    return () => {
      cancelled = true;
    };
  }, [cwd]);

  if (files.length === 0) return null;

  const label = files.length === 1 ? '1 instruction file' : `${files.length} instruction files`;
  return (
    <Tooltip label={`Also in the model's prompt:\n${summarise(files)}`}>
      <button
        type="button"
        className="pd-instructions-chip pd-focusable"
        data-testid="instructions-chip"
        onClick={() => {
          const first = files[0];
          if (first !== undefined) {
            void window.piDesktop.invoke('canvas:reveal', { path: first.path }).catch(() => {});
          }
        }}
      >
        <IconFolder size={12} />
        <span>{label}</span>
      </button>
    </Tooltip>
  );
}
