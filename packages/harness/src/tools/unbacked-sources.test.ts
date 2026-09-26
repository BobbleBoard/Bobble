import { describe, expect, it } from 'vitest';
import { backed, sourcesIn, unbackedSourcesNote } from './unbacked-sources';

/* MEASURED (4B, the visual suite): the solid-state battery brief's References. */
const BRIEF = `SOLID-STATE BATTERIES IN 2026

Executive Summary
Solid-state batteries (SSBs) represent the next-generation energy storage technology.

References
- Toyota Motor Corporation - Technical Reports 2026
- QuantumScape Investor Relations
- Solid Power White Paper 2026
- CATL Annual Technical Report
- SK On Battery Technology Overview
`;

describe('a brief’s sources, held to what the chat read', () => {
  it('reads the section as it is written — bulleted, numbered, or inline', () => {
    expect(sourcesIn(BRIEF)).toHaveLength(5);
    expect(sourcesIn('Intro.\n\n## Sources\n1. https://a.org/x — A\n2. B report\n\nNext')).toEqual([
      'https://a.org/x — A',
      'B report',
    ]);
    expect(sourcesIn('Body text.\nSources: https://a.org/x; https://b.org/y')).toEqual([
      'https://a.org/x',
      'https://b.org/y',
    ]);
    expect(sourcesIn('A brief with no sources at all.')).toEqual([]);
  });

  it('a source is backed by its link or its title in the chat', () => {
    const chat =
      'web fetch https://www.nih.gov/news/fly-brain\nResult: "FlyWire whole-brain connectome"';
    expect(backed('NIH news — https://www.nih.gov/news/fly-brain', chat)).toBe(true);
    expect(backed('FlyWire whole-brain connectome', chat)).toBe(true);
    expect(backed('QuantumScape Investor Relations', chat)).toBe(false);
  });

  it('names the unbacked ones, and says nothing when every one was read', () => {
    const note = unbackedSourcesNote(BRIEF, 'the user asked for a brief with sources');
    expect(note).toContain('"Toyota Motor Corporation - Technical Reports 2026"');
    expect(note).toContain('and 2 more');
    expect(note).toContain('search the web, read the pages');
    expect(unbackedSourcesNote('Sources: https://a.org/x', 'fetched https://a.org/x')).toBe('');
    expect(unbackedSourcesNote('No sources here.', '')).toBe('');
  });
});
