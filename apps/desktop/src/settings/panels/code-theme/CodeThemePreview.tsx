/**
 * THE LIVE PREVIEW under each code-theme picker: a four-line diff and a row
 * of the terminal's sixteen colours, drawn in THAT theme whatever mode the
 * app is in — the light preview stays light while the app is dark, because a
 * person choosing a light theme is looking at what they will get when they
 * switch.
 *
 * It is the real highlighter (the chat's, `highlightCode`) and the real
 * variable names: the theme's values are set as inline custom properties on
 * the preview, so the same `hljs-*` → `--pd-syntax-*` map that colours a
 * reply colours this. Nothing here is a second rendering of the theme that
 * could disagree with the first.
 */
import {
  ANSI_NAMES,
  type AnsiName,
  type CodeTheme,
  codeThemeVariables,
} from '@pi-desktop/code-themes';
import { highlightCode } from '@pi-desktop/ui';
import type { CSSProperties } from 'react';
import { useMemo } from 'react';

/** The sample every theme is shown on — the same lines, so themes compare. */
const SAMPLE: ReadonlyArray<{ number: number; mark: '' | '-' | '+'; code: string }> = [
  { number: 1, mark: '', code: 'function greet(name: string) {' },
  { number: 2, mark: '-', code: '  return "Hello, " + name;' },
  // The sample's template literal is source text, not a placeholder of ours.
  // biome-ignore lint/suspicious/noTemplateCurlyInString: sample code
  { number: 2, mark: '+', code: '  return `Hello, ${name}!`;' },
  { number: 3, mark: '', code: '}' },
];

/** `brightBlack` → "bright black". */
function ansiLabel(name: AnsiName): string {
  return name.replace(/([A-Z])/g, ' $1').toLowerCase();
}

export function CodeThemePreview({ theme, testId }: { theme: CodeTheme; testId?: string }) {
  // Every variable the app's code surfaces read, pinned to this theme on the
  // preview's own element, so the highlighter's classes resolve to it here
  // regardless of what the document-level theme says.
  const vars = useMemo(() => {
    const style: Record<string, string> = {};
    for (const [name, value] of codeThemeVariables(theme)) style[name] = value;
    return style as CSSProperties;
  }, [theme]);
  const lines = useMemo(
    () => SAMPLE.map((line) => ({ ...line, html: highlightCode(line.code, 'typescript').html })),
    [],
  );

  return (
    <div
      className="pd-code-preview"
      data-testid={testId}
      data-code-theme={theme.id}
      style={{
        ...vars,
        background: theme.editor.bg,
        color: theme.editor.fg,
        borderColor: theme.mode === 'dark' ? '#ffffff1a' : '#0000001a',
      }}
    >
      <div className="pd-code-preview-code">
        {lines.map((line, index) => (
          <div
            // The sample is fixed, so its index is its identity.
            // biome-ignore lint/suspicious/noArrayIndexKey: static sample rows
            key={index}
            className="pd-code-preview-line"
            data-mark={line.mark || undefined}
            style={
              line.mark === '+'
                ? { background: theme.diff.addedBg }
                : line.mark === '-'
                  ? { background: theme.diff.removedBg }
                  : undefined
            }
          >
            <span className="pd-code-preview-number" style={{ color: theme.editor.lineNumber }}>
              {line.number}
            </span>
            <span
              className="pd-code-preview-mark"
              style={{
                color:
                  line.mark === '+'
                    ? theme.diff.addedMarker
                    : line.mark === '-'
                      ? theme.diff.removedMarker
                      : undefined,
              }}
            >
              {line.mark}
            </span>
            <code
              className="hljs"
              // biome-ignore lint/security/noDangerouslySetInnerHtml: highlight.js output of a fixed sample — escaped text, class spans only
              dangerouslySetInnerHTML={{ __html: line.html }}
            />
          </div>
        ))}
      </div>
      <ul
        className="pd-code-preview-terminal"
        style={{
          background: theme.terminal.bg === '#00000000' ? undefined : theme.terminal.bg,
          color: theme.terminal.fg,
          borderColor: theme.mode === 'dark' ? '#ffffff1a' : '#0000001a',
        }}
        aria-label="Terminal colours"
      >
        {ANSI_NAMES.map((name) => (
          <li
            key={name}
            className="pd-code-preview-ansi"
            data-ansi={name}
            style={{ color: theme.terminal.ansi[name] }}
          >
            {ansiLabel(name)}
          </li>
        ))}
      </ul>
    </div>
  );
}
