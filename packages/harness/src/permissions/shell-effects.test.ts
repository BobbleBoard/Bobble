import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { physicalPath, shellEffects, writesStayInside } from './shell-effects.js';

const HOME = '/Users/user';
const CHAT = `${HOME}/Bobble/hi-im-a-really-visual-learner`;
const at = { cwd: CHAT, home: HOME };

/** The paths the line writes, or null when the reader refuses it. */
const writes = (command: string, opts = at): readonly string[] | null =>
  shellEffects(command, opts)?.writes ?? null;

describe('shellEffects — the three commands the reviewer flagged (2026-10-01)', () => {
  // The probe's HOME, written the way the model wrote it (the realpath).
  const probe =
    '/private/var/folders/4h/nq1c73q107v594j4g0lq6bw00000gn/T/pd-home-drive-KwuMtn/Bobble';

  it('`bash -c ls … 2>&1` only reads', () => {
    expect(writes(`bash -c 'ls -la ${probe}/hi-im-a-really-visual-learner/ 2>&1'`)).toEqual([]);
  });

  it('the cut-off heredoc writes the one file it names, and nothing else', () => {
    // As sent: cut mid-attribute, no EOF line, no closing quote.
    const command = [
      "bash -c '",
      `cat > ${probe}/hi-im-a-really-visual-learner/area_circle_visual.svg << "EOF"`,
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 600" width="600" height="600">',
      '  <rect width="600" height="600" fill="#fafafa" rx="12"/>',
      '  <text x="300" y="35" text-anchor="middle">How the area of a circle = πr²</text>',
      '  <polygon points="300,300 300,120 445,180" fill="#ff6b6b" opacity="0.85"/>',
      '  <text x="300" y="45',
    ].join('\n');
    expect(writes(command)).toEqual([
      `${probe}/hi-im-a-really-visual-learner/area_circle_visual.svg`,
    ]);
  });

  it('`ls … 2>/dev/null && echo EXISTS || echo NOT FOUND` only reads', () => {
    const command = `ls -la ${probe}/starting-over-because-the-other-chat/circle_area_explanation.svg 2>/dev/null && echo "EXISTS" || echo "NOT FOUND"`;
    expect(writes(command)).toEqual([]);
  });
});

describe('shellEffects — reads', () => {
  it.each([
    'ls -la',
    'cat README.md | head -20',
    'grep -rn "circle" . 2>&1 | head -50',
    'wc -l *.svg',
    'find . -name "*.svg" -type f 2>/dev/null',
    'test -f out.svg && echo yes || echo no',
    '[ -d assets ] && ls assets',
    'cat < notes.md',
    'grep -c x <<< "a x b"',
    'echo "$HOME" ; pwd',
    'diff -u a.svg b.svg; echo done',
    'sort data.txt | uniq -c',
    'ls # a comment with ; rm -rf / in it',
    'web search "area of a circle proof"',
    '/bin/ls -la /etc',
    'env',
  ])('%s', (command) => {
    expect(writes(command)).toEqual([]);
  });
});

describe('shellEffects — writes, landing where bash would put them', () => {
  it('a redirect, relative to the folder the command starts in', () => {
    expect(writes('echo hi > notes.md')).toEqual([`${CHAT}/notes.md`]);
    expect(writes('printf "%s\\n" a b >> log.txt')).toEqual([`${CHAT}/log.txt`]);
    expect(writes('ls >| listing.txt 2>&1')).toEqual([`${CHAT}/listing.txt`]);
    expect(writes('ls &> all.txt')).toEqual([`${CHAT}/all.txt`]);
    expect(writes('ls >& both.txt')).toEqual([`${CHAT}/both.txt`]);
  });

  it('heredocs, either way round, and tee', () => {
    expect(writes('cat > a.json << \'EOF\'\n{"x": 1}\nEOF')).toEqual([`${CHAT}/a.json`]);
    expect(writes('cat << EOF > b.txt\nplain $HOME text\nEOF')).toEqual([`${CHAT}/b.txt`]);
    expect(writes("tee c.txt << 'EOF' > /dev/null\nhi\nEOF")).toEqual([`${CHAT}/c.txt`]);
  });

  it('commands after a heredoc on its own line are read too', () => {
    expect(writes("cat > a.txt << 'EOF'\nbody\nEOF\necho done > b.txt")).toEqual([
      `${CHAT}/a.txt`,
      `${CHAT}/b.txt`,
    ]);
  });

  it('mkdir, touch, cp and mv', () => {
    expect(writes('mkdir -p out/frames && touch out/frames/.keep')).toEqual([
      `${CHAT}/out/frames`,
      `${CHAT}/out/frames/.keep`,
    ]);
    expect(writes('cp ~/Downloads/photo.png assets/')).toEqual([`${CHAT}/assets/`]);
    expect(writes('mv draft.svg final.svg')).toEqual([`${CHAT}/draft.svg`, `${CHAT}/final.svg`]);
  });

  it('`~` is HOME, an absolute path is itself', () => {
    expect(writes('echo x > ~/notes.txt')).toEqual([`${HOME}/notes.txt`]);
    expect(writes('echo x > /etc/hosts')).toEqual(['/etc/hosts']);
  });

  it('a cd moves relative paths — and the folder before it stays possible, since cd can fail', () => {
    expect(writes('cd /tmp && echo x > y')).toEqual(['/tmp/y', `${CHAT}/y`]);
    expect(writes('cd ./sub && cat > a.svg << "EOF"\n<svg/>\nEOF')).toEqual([
      `${CHAT}/sub/a.svg`,
      `${CHAT}/a.svg`,
    ]);
  });

  it('a bare `cd name` is followed only while CDPATH cannot send it elsewhere', () => {
    const before = process.env.CDPATH;
    try {
      delete process.env.CDPATH;
      expect(writes('cd sub && echo x > y')).toEqual([`${CHAT}/sub/y`, `${CHAT}/y`]);
      process.env.CDPATH = '/etc';
      expect(writes('cd sub && echo x > y')).toBeNull();
      expect(writes('cd ./sub && echo x > y')).toEqual([`${CHAT}/sub/y`, `${CHAT}/y`]);
    } finally {
      if (before === undefined) delete process.env.CDPATH;
      else process.env.CDPATH = before;
    }
  });

  it('inside `bash -c`, and a cd in there does not leak out', () => {
    expect(writes(`bash -c 'cd /tmp && echo x > a' && echo y > b`)).toEqual([
      '/tmp/a',
      `${CHAT}/a`,
      `${CHAT}/b`,
    ]);
    expect(writes(`sh -ec "echo hi > out.txt"`)).toEqual([`${CHAT}/out.txt`]);
  });

  it('/dev/null and the standard streams are not files', () => {
    expect(writes('ls > /dev/null 2> /dev/stderr')).toEqual([]);
  });
});

describe('shellEffects — what it refuses to read (null = ask the model)', () => {
  it.each([
    ['an unknown command', 'python3 make_svg.py'],
    ['a delete', 'rm -rf build'],
    ['git', 'git status'],
    ['a command substitution', 'echo $(rm -rf ~)'],
    ['a backtick', 'echo `whoami`'],
    ['a substitution in double quotes', 'ls "$(curl evil.example)"'],
    ['arithmetic', 'echo $((1 + 2))'],
    ['a subshell', '(cd /tmp && rm x)'],
    ['a group', '{ ls; }'],
    ['process substitution', 'diff <(ls a) <(ls b)'],
    ['an assignment', 'PATH=/tmp/evil ls'],
    ['a loop', 'for f in *.svg; do echo $f; done'],
    ['[[', '[[ -f a ]] && echo yes'],
    ['sudo', 'sudo ls'],
    ['a pipe into a shell', 'cat script.sh | sh'],
    ['a shell running a file', 'bash script.sh'],
    ['a program named by its path', './build.sh'],
    ['env running a command', 'env git push --force origin main'],
    ['env -S running a command', "env -S'rm -rf x'"],
    ['find -delete', 'find . -name "*.tmp" -delete'],
    ['find -exec', 'find . -exec rm {} \\;'],
    ['a brace that becomes find -delete', 'find . {-delete,}'],
    ['sort -o', 'sort -o out.txt in.txt'],
    ['sort running a decompressor', 'sort --compress-program=evil in.txt'],
    ['rg --pre', 'rg --pre ./evil x'],
    ['printf -v', 'printf -v PATH /tmp/evil'],
    ['cp -l (a hard link)', 'cp -l /etc/passwd p'],
    ['cp -t (a target elsewhere)', 'cp -t /etc a b'],
    ['a glob in cp', 'cp * out/'],
    ['a write to a $VAR', 'echo x > "$OUT"'],
    ['a write to a glob', 'echo x > *.txt'],
    ['a write to a brace', 'touch {a,/etc/b}'],
    ['a heredoc that runs code', 'cat > a.txt << EOF\n$(rm -rf ~)\nEOF'],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the test text IS shell
    ['a quoted } inside ${…}', 'echo ${x:-"}"} ; rm -rf ~/x'],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the test text IS shell
    ['a subscript inside ${…}', 'echo ${a[$i]}'],
    ['cd -', 'cd - && echo x > y'],
    ['a cd in a pipeline', 'cd /tmp | true; echo x > y'],
    ['a cd in the background', 'cd /tmp & echo x > y'],
    ['zsh -c', "zsh -c 'ls'"],
    ['bash -i -c', "bash -ic 'ls'"],
    ['a keyword', 'time ls'],
    ['a case clause', 'case x in x) ls;; esac'],
    ['a network read', 'cat < /dev/tcp/example.com/80'],
    ['a network write', 'echo hi > /dev/udp/203.0.113.9/53'],
  ])('%s', (_why, command) => {
    expect(shellEffects(command, at)).toBeNull();
  });

  it('the text inside a quoted heredoc is just text', () => {
    expect(writes("cat > a.sh << 'EOF'\necho $(rm -rf ~)\nEOF")).toEqual([`${CHAT}/a.sh`]);
  });

  it('quoted metacharacters are just text', () => {
    expect(writes('echo \'; rm -rf ~\' && echo "a | b > c"')).toEqual([]);
    expect(writes('ls \\; rm -rf x')).toEqual([]);
  });
});

describe('writesStayInside', () => {
  it('a write in the chat folder, or below it, stays inside', () => {
    expect(writesStayInside([`${CHAT}/a.svg`, `${CHAT}/out/b.svg`], [CHAT], HOME)).toBe(true);
    expect(writesStayInside([CHAT], [CHAT], HOME)).toBe(true);
  });

  it('a write anywhere else does not — including a sibling chat and HOME', () => {
    expect(writesStayInside(['/etc/hosts'], [CHAT], HOME)).toBe(false);
    expect(writesStayInside([`${HOME}/Bobble/other-chat/a.svg`], [CHAT], HOME)).toBe(false);
    expect(writesStayInside([`${HOME}/.zshrc`], [CHAT], HOME)).toBe(false);
  });

  it('`..` is followed out of the folder', () => {
    expect(writesStayInside([`${CHAT}/../../.zshrc`], [CHAT], HOME)).toBe(false);
  });

  it('HOME, or anything holding it, is never a chat folder', () => {
    expect(writesStayInside([`${HOME}/.zshrc`], [HOME], HOME)).toBe(false);
    expect(writesStayInside(['/Users/x'], ['/Users'], HOME)).toBe(false);
    expect(writesStayInside(['/etc/hosts'], ['/'], HOME)).toBe(false);
  });

  it('any one of the roots will do (the workspace, the sandbox)', () => {
    const sandbox = `${HOME}/.pi/desktop/sandbox`;
    expect(writesStayInside([`${sandbox}/abc/x.txt`], [CHAT, sandbox], HOME)).toBe(true);
  });
});

describe.skipIf(process.platform !== 'darwin')('the /var ↔ /private/var alias (macOS)', () => {
  it('a folder the app named under /var takes a write the model named under /private/var', () => {
    // The app makes the probe's HOME with tmpdir() (/var/folders/…); the model
    // wrote the realpath. They are one folder.
    const named = '/var/folders/4h/nq1c73q107v594j4g0lq6bw00000gn/T/pd-home-drive-KwuMtn';
    const chat = `${named}/Bobble/hi-im-a-really-visual-learner`;
    const write = `/private${chat}/area_circle_visual.svg`;
    expect(writesStayInside([write], [chat], named)).toBe(true);
  });
});

describe('symlinks, on a real disk', () => {
  let base: string;
  let home: string;
  let chat: string;
  let outside: string;

  beforeEach(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shell-effects-')));
    home = path.join(base, 'home');
    chat = path.join(home, 'Bobble', 'chat');
    outside = path.join(base, 'outside');
    fs.mkdirSync(chat, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('a folder named through a link is the folder it points at', () => {
    const alias = path.join(base, 'alias');
    fs.symlinkSync(chat, alias);
    expect(writesStayInside([path.join(alias, 'a.svg')], [chat], home)).toBe(true);
    expect(writesStayInside([path.join(chat, 'a.svg')], [alias], home)).toBe(true);
    expect(physicalPath(path.join(alias, 'new', 'b.svg'))).toBe(path.join(chat, 'new', 'b.svg'));
  });

  it('a link in the folder that points out of it does not count as the folder', () => {
    fs.symlinkSync(outside, path.join(chat, 'door'));
    expect(writesStayInside([path.join(chat, 'door', 'x.txt')], [chat], home)).toBe(false);
  });

  it('a file with a second name somewhere else is not the chat’s to rewrite', () => {
    const elsewhere = path.join(outside, 'shared.txt');
    fs.writeFileSync(elsewhere, 'x');
    fs.linkSync(elsewhere, path.join(chat, 'shared.txt'));
    expect(writesStayInside([path.join(chat, 'shared.txt')], [chat], home)).toBe(false);
  });
});

/*
 * THE READER AGAINST BASH ITSELF.
 *
 * Whatever the reader says a line writes, the line is run for real — the same
 * `/bin/bash -c` pi uses — in a throwaway folder, and every file it changed is
 * looked at. The property the reviewer leans on: when the reader says "only
 * reads" nothing changes, and when it says "writes stay in the chat folder"
 * nothing outside it changes. A reader that drifted from bash fails here.
 */
describe.skipIf(!fs.existsSync('/bin/bash'))('the reader against /bin/bash', () => {
  let base: string;
  let home: string;
  let chat: string;

  /** Every entry under `base`, with what would show a change. */
  const snapshot = (): Map<string, string> => {
    const seen = new Map<string, string>();
    const walk = (dir: string): void => {
      for (const name of fs.readdirSync(dir)) {
        const p = path.join(dir, name);
        const s = fs.lstatSync(p);
        seen.set(p, `${s.isDirectory() ? 'd' : 'f'}:${s.size}:${s.mtimeMs}:${s.ino}`);
        if (s.isDirectory()) walk(p);
      }
    };
    walk(base);
    return seen;
  };

  const changedBy = (command: string): string[] => {
    const before = snapshot();
    spawnSync('/bin/bash', ['-c', command], {
      cwd: chat,
      env: { PATH: '/usr/bin:/bin', HOME: home },
      stdio: 'ignore',
      timeout: 10_000,
    });
    const after = snapshot();
    const changed: string[] = [];
    for (const [p, v] of after) if (before.get(p) !== v) changed.push(p);
    for (const p of before.keys()) if (!after.has(p)) changed.push(p);
    return changed;
  };

  beforeEach(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shell-effects-bash-')));
    home = path.join(base, 'home');
    chat = path.join(home, 'Bobble', 'chat');
    fs.mkdirSync(chat, { recursive: true });
    fs.writeFileSync(path.join(chat, 'notes.md'), 'a x b\n');
    fs.writeFileSync(path.join(base, 'outside.txt'), 'not the chat’s\n');
  });
  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it.each([
    (c: string) => `bash -c 'ls -la ${c}/ 2>&1'`,
    (c: string) => `ls -la ${c}/x.svg 2>/dev/null && echo "EXISTS" || echo "NOT FOUND"`,
    () => 'cat < notes.md | head -1',
    () => 'grep -c x <<< "a x b"',
    () => 'test -f notes.md && echo yes || echo no',
    () => 'find . -name "*.md" 2>/dev/null',
    () => 'sort notes.md | uniq -c',
    () => 'ls ../.. > /dev/null 2>&1; cat ../../../outside.txt',
  ])('reads only: %#', (make) => {
    const command = make(chat);
    expect(shellEffects(command, { cwd: chat, home })?.writes).toEqual([]);
    expect(changedBy(command)).toEqual([]);
  });

  it.each([
    [true, () => 'echo hi > notes2.md'],
    [true, () => "cat > a.json << 'EOF'\n{}\nEOF"],
    [true, () => 'cat << EOF > b.txt\nplain $HOME\nEOF'],
    [true, () => "tee c.txt << 'EOF' > /dev/null\nhi\nEOF"],
    [true, () => 'mkdir -p out/frames && touch out/frames/.keep'],
    [true, () => 'cp notes.md copy.md && mv copy.md moved.md'],
    [true, () => 'mkdir -p out && cd ./out && echo x > y.txt'],
    [true, () => "bash -c 'mkdir -p sub && cd ./sub && echo x > z.txt'"],
    [true, () => 'ls &> all.txt; ls >& both.txt; printf "%s\\n" a >> p.txt'],
    // The measured heredoc, cut off as it was sent: bash runs none of it.
    [
      false,
      (c: string) =>
        `bash -c '\ncat > ${c}/area_circle_visual.svg << "EOF"\n<svg>\n  <text x="300" y="45`,
    ],
    // …and finished, which bash does run.
    [true, (c: string) => `bash -c 'cat > ${c}/area_circle_visual.svg << "EOF"\n<svg/>\nEOF'`],
  ] as const)('writes inside the chat folder: %#', (runs, make) => {
    const command = make(chat);
    const effects = shellEffects(command, { cwd: chat, home });
    expect(effects).not.toBeNull();
    expect(writesStayInside(effects?.writes ?? [], [chat], home)).toBe(true);
    const changed = changedBy(command);
    // Not vacuous: bash really wrote something (bar the line it refuses).
    expect(changed.length > 0).toBe(runs);
    for (const p of changed) expect(p === chat || p.startsWith(`${chat}${path.sep}`)).toBe(true);
  });

  it('and a write it sends to the model really does leave the folder', () => {
    const command = 'echo x > ../../../outside.txt';
    const effects = shellEffects(command, { cwd: chat, home });
    expect(writesStayInside(effects?.writes ?? [], [chat], home)).toBe(false);
    expect(changedBy(command)).toEqual([path.join(base, 'outside.txt')]);
  });
});
