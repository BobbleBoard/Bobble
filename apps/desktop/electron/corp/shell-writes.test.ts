/**
 * The shapes agents actually use to write files from a shell, and the ones that
 * must NOT be mistaken for writes. A false positive here accuses the wrong agent
 * of owning a file, which is worse than missing one.
 */
import { describe, expect, it } from 'vitest';
import { heredocBody, shellWrites } from './shell-writes';

const paths = (cmd: string): string[] => shellWrites(cmd).map((w) => w.path);

describe('heredocs — how run 19’s manager built the whole product', () => {
  it('sees `cat > file << EOF`', () => {
    expect(paths("cat > converter.py << 'EOF'\nimport json\nEOF")).toEqual(['converter.py']);
  });

  it('sees an unquoted heredoc marker and a nested path', () => {
    expect(paths('cat > tests/test_converter.py <<EOF\nassert True\nEOF')).toEqual([
      'tests/test_converter.py',
    ]);
  });

  it('sees a heredoc after a `mkdir -p` — the exact run 19 line', () => {
    expect(paths("mkdir -p tests && cat > tests/test_converter.py << 'EOF'\nx\nEOF")).toEqual([
      'tests/test_converter.py',
    ]);
  });

  it('distinguishes append from replace', () => {
    // `body` is now carried too (the heredoc's text, for the live canvas), so
    // this asserts the append/replace decision rather than the whole shape.
    expect(shellWrites('cat >> notes.md << EOF\nhi\nEOF')[0]).toMatchObject({
      path: 'notes.md',
      append: true,
    });
    expect(shellWrites('cat > notes.md << EOF\nhi\nEOF')[0]?.append).toBe(false);
  });
});

describe('python heredocs that write from inside the script', () => {
  it('sees open(path, "w")', () => {
    const cmd = `python3 << 'EOF'
import json
with open('out.csv', 'w') as f:
    f.write('a,b')
EOF`;
    expect(paths(cmd)).toEqual(['out.csv']);
  });

  it('sees several writes, and pathlib', () => {
    const cmd = `python3 << 'EOF'
open("a.json", "w").write("{}")
Path('b.yaml').write_text('x: 1')
EOF`;
    expect(paths(cmd)).toEqual(['a.json', 'b.yaml']);
  });

  it('ignores files opened for READING', () => {
    expect(paths(`python3 << 'EOF'\nopen('in.json', 'r').read()\nEOF`)).toEqual([]);
  });
});

describe('plain redirects and tee', () => {
  it('sees a simple redirect and printf', () => {
    expect(paths("echo '{}' > test.json")).toEqual(['test.json']);
    expect(paths('printf "a,b\\n" > data.csv')).toEqual(['data.csv']);
  });

  it('sees tee, with and without -a', () => {
    expect(shellWrites('echo hi | tee out.txt')[0]).toEqual({ path: 'out.txt', append: false });
    expect(shellWrites('echo hi | tee -a out.txt')[0]?.append).toBe(true);
  });
});

describe('what must NOT be counted as writing a product file', () => {
  it('ignores stderr redirects and /dev/null', () => {
    expect(paths('python3 -m pytest -q 2>&1 | head -50')).toEqual([]);
    expect(paths('which pytest > /dev/null')).toEqual([]);
    expect(paths('python3 x.py 2> errors.log')).toEqual([]);
  });

  it('ignores paths the shell would expand — we cannot know what they became', () => {
    expect(paths('cat > $OUT << EOF\nx\nEOF')).toEqual([]);
    expect(paths('cat > ~/notes.md << EOF\nx\nEOF')).toEqual([]);
    expect(paths('cat > "$(date).txt" << EOF\nx\nEOF')).toEqual([]);
  });

  it('ignores reading, piping and comparing', () => {
    expect(paths('cat converter.py')).toEqual([]);
    expect(paths('python3 converter.py in.json out.csv')).toEqual([]);
    expect(paths('diff a.csv b.csv')).toEqual([]);
    expect(paths('ls -la && grep -n foo bar.py')).toEqual([]);
  });

  it('never throws, whatever it is handed', () => {
    for (const junk of ['', '>>>', 'cat >', '>', '| tee']) {
      expect(() => shellWrites(junk)).not.toThrow();
    }
  });
});

describe('a command that writes more than one file', () => {
  it('reports each once, replace winning over append', () => {
    const cmd = "cat > a.py << 'EOF'\nx\nEOF\ncat >> a.py << 'EOF'\ny\nEOF\necho z > b.txt";
    expect(paths(cmd).sort()).toEqual(['a.py', 'b.txt']);
    expect(shellWrites(cmd).find((w) => w.path === 'a.py')?.append).toBe(false);
  });
});

describe('heredocBody — the live-write body for a shell write', () => {
  it('captures a quoted heredoc, which is how agents actually write files', () => {
    // Verbatim shape from the corp run: the manager wrote project.godot this
    // way, and the canvas showed a blank file because nothing carried the text.
    const cmd = 'cat << \'PROJECTGODOT\' > project.godot\n[config]\nname = "x"\nPROJECTGODOT';
    expect(heredocBody(cmd)).toBe('[config]\nname = "x"\n');
    const w = shellWrites(cmd);
    expect(w[0]?.path).toBe('project.godot');
    expect(w[0]?.body).toContain('[config]');
  });

  it('captures a bare heredoc too', () => {
    expect(heredocBody('cat << EOF > a.txt\nhello\nEOF')).toBe('hello\n');
  });

  it('is undefined when the command has no heredoc', () => {
    // A redirect from a pipeline has a body we cannot know without running it —
    // undefined, never an empty string, so the canvas can tell the two apart.
    expect(heredocBody('echo hi > a.txt')).toBeUndefined();
    expect(shellWrites('echo hi > a.txt')[0]?.body).toBeUndefined();
  });
});
