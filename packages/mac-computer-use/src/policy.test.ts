import { describe, expect, it } from 'vitest';
import { policyVerdict } from './policy.js';

const policy = {
  enabled: true,
  apps: [
    { id: 'com.apple.TextEdit', name: 'TextEdit' },
    { id: 'com.google.Chrome', name: 'Google Chrome' },
    { id: 'com.example.go', name: 'Go' },
  ],
};

describe('the standing computer-use policy', () => {
  it('off refuses everything, whatever the app', () => {
    expect(policyVerdict({ enabled: false, apps: policy.apps }, 'TextEdit')).toBe('off');
    expect(policyVerdict({ enabled: false, apps: [] }, undefined)).toBe('off');
  });

  it('no policy at all means the gate asks, as it always did', () => {
    expect(policyVerdict(null, 'TextEdit')).toBe('ask');
    expect(policyVerdict(undefined, 'TextEdit')).toBe('ask');
  });

  it('a listed app is allowed by name or by bundle id, in any case', () => {
    expect(policyVerdict(policy, 'TextEdit')).toBe('allowed');
    expect(policyVerdict(policy, 'textedit')).toBe('allowed');
    expect(policyVerdict(policy, 'com.apple.textedit')).toBe('allowed');
    expect(policyVerdict(policy, 'Google Chrome')).toBe('allowed');
  });

  it('a listed name inside how the model said it still counts', () => {
    expect(policyVerdict(policy, 'the TextEdit app')).toBe('allowed');
    expect(policyVerdict(policy, 'Google Chrome browser')).toBe('allowed');
  });

  it('an unlisted app asks — the list is pre-approval, not a fence', () => {
    expect(policyVerdict(policy, 'Preview')).toBe('ask');
    expect(policyVerdict(policy, 'Terminal')).toBe('ask');
  });

  it('a short name only matches exactly, so "Go" cannot approve Google', () => {
    expect(policyVerdict(policy, 'Go')).toBe('allowed');
    expect(policyVerdict(policy, 'Google Earth')).toBe('ask');
    expect(policyVerdict(policy, 'Godot')).toBe('ask');
  });

  it('a name that is a prefix of another app is not that app', () => {
    const p = { enabled: true, apps: [{ id: 'com.apple.Notes', name: 'Notes' }] };
    expect(policyVerdict(p, 'Notesmith')).toBe('ask');
    expect(policyVerdict(p, 'Apple Notes')).toBe('allowed');
  });

  it('an act naming no app is neither allowed nor refused here', () => {
    expect(policyVerdict(policy, undefined)).toBe('ask');
    expect(policyVerdict(policy, '  ')).toBe('ask');
  });
});
