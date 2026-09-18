import { clsx } from 'clsx';
import type { HTMLAttributes } from 'react';
import { forwardRef, useMemo } from 'react';
import { highlightCode, highlightLanguage, splitHighlightedLines } from '../highlight.ts';
import { DiffStat } from './activity.tsx';
import { emphasizeHtml, pairChanges } from './diff-emphasis.ts';

/*
 * Diff view — the shape of the references (the user, 2026-09-17, with a picture):
 * a line-number gutter, a `−`/`+` marker beside it, the whole row tinted red
 * or green, the code syntax-coloured inside the tint, and a second, stronger
 * tint on the stretch of a line that actually changed. No bar down the left
 * edge and no header strip — the row that opened this already names the file.
 *
 * A NEW FILE IS NOT A DIFF. Every line of a whole-file write is an addition,
 * and painting eighty-eight rows green says nothing a reader can use (and was
 * the "green field" the user already sent back once in the canvas). A file with
 * only additions renders as a numbered listing: the row's +N is its stat.
 *
 * Flavors supply the hues via --pd-* tokens; the tint math lives in diff.css.
 */

export type DiffLineKind = 'add' | 'del' | 'context' | 'hunk';

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  oldNumber?: number;
  newNumber?: number;
}

export interface DiffFileData {
  path: string;
  added?: number;
  deleted?: number;
  lines: DiffLine[];
  /** Grammar for syntax colour; inferred from the path's extension when absent. */
  language?: string;
}

export interface DiffViewProps extends HTMLAttributes<HTMLDivElement> {
  files: DiffFileData[];
  /** Leading +/− markers in the gutter. */
  showMarkers?: boolean;
  /** A sticky strip naming the file with its ±stat. Off by default: the row
   * that discloses a diff already says which file it is. */
  showHeader?: boolean;
}

const ROW_CLASS: Record<Exclude<DiffLineKind, 'hunk'>, string> = {
  add: 'pd-diff-row pd-diff-row--add',
  del: 'pd-diff-row pd-diff-row--del',
  context: 'pd-diff-row pd-diff-row--context',
};

const MARKERS: Record<Exclude<DiffLineKind, 'hunk'>, string> = {
  add: '+',
  del: '−',
  context: ' ',
};

const EMPH_CLASS: Record<Exclude<DiffLineKind, 'hunk'>, string> = {
  add: 'pd-diff-emph pd-diff-emph--add',
  del: 'pd-diff-emph pd-diff-emph--del',
  context: '',
};

/** The grammar a file's extension names, for the colours; null when none. */
function grammarFor(file: DiffFileData): string | null {
  if (file.language !== undefined) return highlightLanguage(file.language);
  const dot = file.path.lastIndexOf('.');
  return dot === -1 ? null : highlightLanguage(file.path.slice(dot + 1));
}

/**
 * Every row's HTML: the old side (context + deletions) and the new side
 * (context + additions) are each highlighted as ONE text so a grammar's state
 * survives across lines, then split back per row — and the changed stretch of
 * a paired deletion/addition is wrapped in its emphasis span.
 */
function rowsHtml(file: DiffFileData, grammar: string | null): string[] {
  const oldRows: number[] = [];
  const newRows: number[] = [];
  file.lines.forEach((line, i) => {
    if (line.kind === 'del' || line.kind === 'context') oldRows.push(i);
    if (line.kind === 'add' || line.kind === 'context') newRows.push(i);
  });
  const side = (rows: number[]): string[] => {
    const text = rows.map((i) => file.lines[i]?.text ?? '').join('\n');
    const { html } = highlightCode(text, grammar ?? undefined);
    return splitHighlightedLines(html);
  };
  const oldHtml = side(oldRows);
  const newHtml = side(newRows);
  const html = new Array<string>(file.lines.length).fill('');
  oldRows.forEach((row, k) => {
    html[row] = oldHtml[k] ?? '';
  });
  newRows.forEach((row, k) => {
    html[row] = newHtml[k] ?? '';
  });
  const ranges = pairChanges(file.lines);
  for (const [row, range] of ranges) {
    const kind = file.lines[row]?.kind;
    if (kind !== 'add' && kind !== 'del') continue;
    html[row] = emphasizeHtml(html[row] ?? '', range, EMPH_CLASS[kind]);
  }
  return html;
}

function DiffFile({
  file,
  showMarkers,
  showHeader,
}: {
  file: DiffFileData;
  showMarkers: boolean;
  showHeader: boolean;
}) {
  const grammar = useMemo(() => grammarFor(file), [file]);
  const html = useMemo(() => rowsHtml(file, grammar), [file, grammar]);
  const newFile = file.lines.length > 0 && file.lines.every((line) => line.kind === 'add');
  let rowIndex = 0;
  return (
    <section data-new-file={newFile ? 'true' : undefined}>
      {showHeader ? (
        <header className="pd-diff-file-header">
          <span>{file.path}</span>
          <DiffStat added={file.added} deleted={file.deleted} />
        </header>
      ) : null}
      <div className="pd-diff-body">
        {file.lines.map((line, i) => {
          rowIndex += 1;
          const key = `${file.path}#${rowIndex}`;
          if (line.kind === 'hunk') {
            return (
              <div key={key} className="pd-diff-row pd-diff-row--hunk">
                {line.text}
              </div>
            );
          }
          const number = line.kind === 'del' ? line.oldNumber : (line.newNumber ?? line.oldNumber);
          return (
            <div key={key} className={ROW_CLASS[line.kind]}>
              <span className="pd-diff-gutter" data-line-number={number ?? ''} />
              {showMarkers ? (
                <span className="pd-diff-marker" aria-hidden="true">
                  {newFile ? ' ' : MARKERS[line.kind]}
                </span>
              ) : null}
              <span
                className="pd-diff-text"
                // biome-ignore lint/security/noDangerouslySetInnerHtml: highlight.js output — the source is escaped, the only markup is its class spans and the emphasis span
                dangerouslySetInnerHTML={{ __html: html[i] ?? '' }}
              />
            </div>
          );
        })}
      </div>
    </section>
  );
}

export const DiffView = forwardRef<HTMLDivElement, DiffViewProps>(function DiffView(
  { files, showMarkers = true, showHeader = false, className, ...rest },
  ref,
) {
  return (
    <div ref={ref} className={clsx('pd-diff', className)} {...rest}>
      {files.map((file) => (
        <DiffFile key={file.path} file={file} showMarkers={showMarkers} showHeader={showHeader} />
      ))}
    </div>
  );
});
