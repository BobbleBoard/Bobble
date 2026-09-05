/**
 * The guard refuses exactly one thing — removing the directory the work lives
 * in — and stays out of the way of every ordinary destructive command, because
 * a guard that argues with `rm -rf node_modules` is a guard somebody turns off.
 */
import { describe, expect, it } from 'vitest';
import { wouldDestroyWorkspace } from './workspace-guard';

const WS = '/tmp/project';
const HOME = '/Users/someone';
/* NOT a default parameter: passing `undefined` explicitly still takes the
   default, so `guard(cmd, undefined)` would have silently re-tested the
   workspace case. Arity is the only honest way to say "no workspace at all". */
const guard = (...a: [string] | [string, string | undefined]) =>
  wouldDestroyWorkspace(a[0], a.length === 1 ? WS : a[1], { home: HOME });

describe('wouldDestroyWorkspace — what it refuses', () => {
  it('refuses removing the workspace root itself', () => {
    expect(guard('rm -rf /tmp/project')).toMatch(/working directory/);
    expect(guard('rm -rf /tmp/project/')).toMatch(/working directory/);
    expect(guard('rm -fr /tmp/project')).not.toBeNull();
    expect(guard('rm -r -f /tmp/project')).not.toBeNull();
  });

  it('refuses removing a directory that CONTAINS the workspace', () => {
    expect(guard('rm -rf /tmp')).not.toBeNull();
  });

  it('refuses removing $HOME, however it is written', () => {
    expect(guard('rm -rf ~')).toMatch(/home directory/);
    expect(guard('rm -rf $HOME')).toMatch(/home directory/);
    expect(guard('rm -rf ${HOME}')).toMatch(/home directory/);
  });

  it('refuses the root of the filesystem', () => {
    expect(guard('rm -rf /')).not.toBeNull();
  });

  it('sees it inside a compound command, not just at the start', () => {
    expect(guard('cd /tmp && rm -rf /tmp/project')).not.toBeNull();
    expect(guard('echo hi; rm -rf /tmp/project')).not.toBeNull();
  });

  it('resolves a RELATIVE path against the workspace', () => {
    // `rm -rf .` from inside the working directory is the same act.
    expect(guard('rm -rf .')).not.toBeNull();
    expect(guard('rm -rf ..')).not.toBeNull();
  });

  it('refuses MOVING the workspace away — that is deleting it slowly', () => {
    expect(guard('mv /tmp/project /tmp/old')).not.toBeNull();
  });
});

describe('wouldDestroyWorkspace — what it allows', () => {
  it('allows the ordinary destructive commands work is made of', () => {
    expect(guard('rm -rf node_modules')).toBeNull();
    expect(guard('rm -rf /tmp/project/build')).toBeNull();
    expect(guard('rm -rf dist .cache')).toBeNull();
    expect(guard('rm /tmp/project/notes.txt')).toBeNull();
    expect(guard('rm -rf /tmp/somewhere-else')).toBeNull();
  });

  it('allows clearing the CONTENTS of the workspace with a glob', () => {
    // `rm -rf *` removes what is in the directory, not the directory. That is a
    // judgement the agent is allowed to make; naming the directory is not.
    expect(guard('rm -rf *')).toBeNull();
    expect(guard('rm -rf /tmp/project/*')).toBeNull();
  });

  it('allows moving something INTO the workspace', () => {
    expect(guard('mv /tmp/downloaded.zip /tmp/project')).toBeNull();
  });

  it('allows a non-recursive rm of the directory name (it would fail anyway)', () => {
    expect(guard('rm /tmp/project')).toBeNull();
  });

  it('has no opinion when no workspace was ever set', () => {
    expect(guard('rm -rf /tmp/project', undefined)).toBeNull();
    expect(guard('rm -rf ~', '')).toBeNull();
  });

  it('leaves harmless commands entirely alone', () => {
    expect(guard('ls -la')).toBeNull();
    expect(guard('python3 main.py')).toBeNull();
    expect(guard('git rm --cached foo')).toBeNull();
  });
});
