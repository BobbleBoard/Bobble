/**
 * THE FILES A BASH LINE WRITES, AND WHAT IT WRITES INTO THEM.
 *
 * `cat > a.json << 'EOF'`, `cat << EOF > a.json`, `tee a.json << EOF`,
 * `echo '…' > a.json`. MEASURED (the maths suite, qwen3.5-4b, the derivative):
 * its spec typed into bash as `cat > tangent_deriv.json << 'ENDJSON'`, twice,
 * never drawn — a spec written with `write` is drawn in the write's own
 * result, and the same file typed into a heredoc went round that. Then a
 * tangent line drawn by hand as SVG the same way, round the refusal a `write`
 * of it meets. What the line writes is read here so both meet the same rules.
 */

export interface BashWrite {
  /** The target as the line names it (relative to the shell's folder, or absolute). */
  readonly path: string;
  /** The heredoc's text, when the file's contents came from one. */
  readonly body?: string;
}

const TARGET = String.raw`(['"]?)([^\s'"<>;&|()]+)\1`;

export function bashWrites(cmd: string): BashWrite[] {
  const lines = cmd.split('\n');
  const out: BashWrite[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    let body: string | undefined;
    const tag = /<<-?\s*(['"]?)([A-Za-z_]\w*)\1/.exec(line)?.[2];
    if (tag !== undefined) {
      // The body runs to the line that is the tag alone; the redirect is on the line that opened it.
      const end = lines.findIndex((l, j) => j > i && l.trim() === tag);
      const stop = end < 0 ? lines.length : end;
      body = lines.slice(i + 1, stop).join('\n');
      i = stop;
    }
    // `>` and `>>`, not `2>`, `&>`, `>&2` or the `<<` of the heredoc itself.
    const redirects = [
      ...line.matchAll(new RegExp(String.raw`(?:^|[^<>&\d])>>?\s*${TARGET}`, 'g')),
    ];
    const tee = new RegExp(String.raw`\btee\s+(?:-a\s+)?${TARGET}`).exec(line);
    for (const p of [...redirects.map((m) => m[2]), tee?.[2]]) {
      if (p === undefined || p === '/dev/null') continue;
      out.push({ path: p, ...(body !== undefined ? { body } : {}) });
    }
  }
  return out;
}
