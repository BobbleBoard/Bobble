/**
 * THE PROMPT ENHANCER, from the studio's side.
 *
 * The rule this hook exists to enforce: a rewrite you cannot see is a model
 * quietly changing your words. So enhancing REPLACES what is in the composer
 * and does it before the job starts — you read the new prompt, and you can edit
 * it, undo it, or turn the whole thing off. It is not a hidden pre-processing
 * step on the way to the GPU.
 *
 * Off by default, and remembered. On is the better setting for most people, but
 * a feature that silently rewrites your input the first time you ever use the
 * room is the wrong first impression of an app whose whole pitch is that nothing
 * leaves your machine and nothing happens you did not ask for.
 */
import { useCallback, useState } from 'react';

/** The job kinds the enhancer knows. Mirrors the main-process contract. */
export type EnhanceKind = 'image' | 'video' | 'music' | 'sfx' | 'speech';

const KEY = 'pd.studio.enhance';

function readPref(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export interface UseEnhancer {
  readonly enabled: boolean;
  readonly setEnabled: (on: boolean) => void;
  /** True while the small model is thinking — the run button says so. */
  readonly enhancing: boolean;
  /** The prompt before the last rewrite, so it can be put back. */
  readonly previous: string | null;
  readonly undo: () => void;
  /**
   * Rewrite `prompt` for this job and hand back what to generate with. Returns
   * the input unchanged when the toggle is off, when the kind cannot be enhanced
   * (speech), or when anything at all goes wrong — the caller never has to
   * branch on failure.
   */
  readonly enhance: (kind: EnhanceKind, prompt: string, model?: string) => Promise<string>;
}

export function useEnhancer(onRewrite: (next: string) => void): UseEnhancer {
  const [enabled, setEnabledState] = useState<boolean>(readPref);
  const [enhancing, setEnhancing] = useState(false);
  const [previous, setPrevious] = useState<string | null>(null);

  const setEnabled = useCallback((on: boolean): void => {
    setEnabledState(on);
    try {
      localStorage.setItem(KEY, on ? '1' : '0');
    } catch {
      // A blocked store just means the preference is per-session.
    }
  }, []);

  // Reads `previous` directly rather than from inside `setPrevious`: a state
  // updater must be pure, and React is entitled to call it twice — which would
  // put the old prompt back twice and, worse, is the kind of thing that only
  // misbehaves in StrictMode or a future concurrent render.
  const undo = useCallback((): void => {
    if (previous === null) return;
    onRewrite(previous);
    setPrevious(null);
  }, [onRewrite, previous]);

  const enhance = useCallback(
    async (kind: EnhanceKind, prompt: string, model?: string): Promise<string> => {
      if (!enabled || prompt.trim() === '' || kind === 'speech') return prompt;
      setEnhancing(true);
      try {
        const res = await window.piDesktop.invoke('gen:enhance', {
          kind,
          prompt,
          ...(model !== undefined && model !== '' ? { model } : {}),
        });
        if (res.changed) {
          setPrevious(prompt);
          onRewrite(res.prompt);
        }
        return res.prompt;
      } catch {
        // The enhancer is never allowed to block a generation.
        return prompt;
      } finally {
        setEnhancing(false);
      }
    },
    [enabled, onRewrite],
  );

  return { enabled, setEnabled, enhancing, previous, undo, enhance };
}
