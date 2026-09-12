import { describe, expect, it } from 'vitest';
import { attributeGuidelines } from './guidelines.js';

const BASE = `Guidelines:
- Prefer grep/find/ls tools over bash for file exploration (faster, respects .gitignore)
- Use edit for precise changes (edits[].oldText must match exactly)
- Use write only for new files or complete rewrites.
- Make this your last action whenever the task produced a file, folder or project.
- Read the preview it returns. If the artefact is wrong or empty, fix it and present again.
- Use it when the user describes work that repeats or should happen later, not for anything you can just do now.
- Use it for a large, multi-part build that a single pass cannot do well.
- Be concise in your responses
- Show file paths clearly when working with files

Current date: 2026-09-12
Current working directory: /Users/user`;

const SOURCES = [
  {
    name: 'edit',
    guidelines: ['Use edit for precise changes (edits[].oldText must match exactly)'],
  },
  { name: 'write', guidelines: ['Use write only for new files or complete rewrites.'] },
  {
    name: 'present',
    guidelines: [
      'Make this your last action whenever the task produced a file, folder or project.',
      'Read the preview it returns. If the artefact is wrong or empty, fix it and present again.',
    ],
  },
  {
    name: 'create_scheduled_task',
    guidelines: [
      'Use it when the user describes work that repeats or should happen later, not for anything you can just do now.',
    ],
  },
  {
    name: 'talk_to_manager',
    guidelines: ['Use it for a large, multi-part build that a single pass cannot do well.'],
  },
];

describe('attributeGuidelines', () => {
  const out = attributeGuidelines(BASE, SOURCES, {
    active: new Set(['read', 'write', 'edit', 'bash', 'present', 'talk_to_manager']),
  });

  it('names the tool every guideline belongs to', () => {
    expect(out).toContain('- `present`: Make this your last action');
    expect(out).toContain('- `edit`: Use edit for precise changes');
    expect(out).toContain('- `talk_to_manager`: Use it for a large, multi-part build');
  });

  it('drops the guidance of a tool the model does not have', () => {
    // The scheduler was not in the list — its "Use it when…" was the orphan.
    expect(out).not.toContain('work that repeats');
  });

  it('drops the grep/find line when neither is registered, keeps the rest', () => {
    expect(out).not.toContain('Prefer grep/find/ls');
    expect(out).toContain('- Be concise in your responses');
    expect(out).toContain('Current working directory: /Users/user');
  });

  it('prints a command in CLI mode when asked to', () => {
    const cli = attributeGuidelines(BASE, SOURCES, {
      active: new Set(['present']),
      nameFor: (t) => (t === 'present' ? '`coordinate present`' : `\`${t}\``),
    });
    expect(cli).toContain('- `coordinate present`: Make this your last action');
  });

  it('leaves a prompt with no Guidelines block alone', () => {
    expect(attributeGuidelines('hello\n\nworld', SOURCES, { active: new Set() })).toBe(
      'hello\n\nworld',
    );
  });
});
