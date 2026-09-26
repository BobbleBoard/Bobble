import { describe, expect, it } from 'vitest';
import { bashWrites } from './bash-writes.js';

describe('the files a bash line writes', () => {
  it('reads a heredoc into a file, either way round (MEASURED: the 4B’s derivative spec)', () => {
    const spec = '{\n  "title": "Derivative",\n  "plot": {"curves": ["x^2"]}\n}';
    expect(bashWrites(`cat > tangent_deriv.json << 'ENDJSON'\n${spec}\nENDJSON`)).toEqual([
      { path: 'tangent_deriv.json', body: spec },
    ]);
    expect(bashWrites(`cat <<EOF > out/a.svg\n<svg></svg>\nEOF\necho done`)).toEqual([
      { path: 'out/a.svg', body: '<svg></svg>' },
    ]);
    expect(bashWrites(`tee "notes.md" <<- EOF\nhello\nEOF`)).toEqual([
      { path: 'notes.md', body: 'hello' },
    ]);
  });

  it('reads a plain redirect, and leaves stderr, pipes and the heredoc’s own words alone', () => {
    expect(bashWrites(`echo '{"a": 1}' > a.json && ls 2>&1 | head`)).toEqual([{ path: 'a.json' }]);
    expect(bashWrites('npm test 2> /dev/null >> log.txt')).toEqual([{ path: 'log.txt' }]);
    // A ">" inside the heredoc's text is the file's text, not a redirect.
    expect(bashWrites(`cat > f.py << 'EOF'\nif a > b: print(1)\nEOF`)).toEqual([
      { path: 'f.py', body: 'if a > b: print(1)' },
    ]);
    expect(bashWrites('ls -la')).toEqual([]);
  });
});
