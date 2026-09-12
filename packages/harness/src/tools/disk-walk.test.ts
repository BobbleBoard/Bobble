import { describe, expect, it } from 'vitest';
import { diskWalkRefusal, wouldWalkDisk } from './disk-walk.js';

describe('wouldWalkDisk', () => {
  it('catches a find rooted at the disk or at home', () => {
    expect(wouldWalkDisk('find / -name "*.glb" 2>/dev/null')).toEqual({
      root: '/',
      pattern: '*.glb',
    });
    expect(wouldWalkDisk('find ~ -name mug.glb')).toEqual({ root: '~', pattern: 'mug.glb' });
    expect(wouldWalkDisk('cd /tmp && find $HOME -type f -name "*.pptx"')).toEqual({
      root: '$HOME',
      pattern: '*.pptx',
    });
    expect(wouldWalkDisk('find /Users/user -iname "beat.flac"')?.pattern).toBe('beat.flac');
  });
  it('lets an ordinary find through', () => {
    expect(wouldWalkDisk('find . -name "*.ts"')).toBeNull();
    expect(wouldWalkDisk('find src -type f')).toBeNull();
    expect(wouldWalkDisk('find / -maxdepth 2 -name etc')).toBeNull();
    expect(wouldWalkDisk('find /tmp/proj -name x')).toBeNull();
  });
  it('names Spotlight when it is there, and a narrower search when it is not', () => {
    expect(diskWalkRefusal({ root: '/', pattern: '*.glb' }, 'machine search')).toContain(
      'machine search ".glb"',
    );
    expect(diskWalkRefusal({ root: '/', pattern: null }, null)).toContain('-maxdepth 3');
  });
});
