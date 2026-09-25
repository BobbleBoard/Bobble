/**
 * WHICH KIT A PROJECT WEARS.
 *
 * In order (deliverables/research/visual-quality.md §4.6): the project's own
 * `brand.md`, which "wins over `design.kit`" because it is about this project;
 * then the kit the Design setting names; then the house default. One kit per
 * project, so a deck, its charts and its diagrams belong together, and
 * variety comes across projects.
 *
 * A brand file that cannot be made readable (validate.ts, after brand.ts's
 * repairs) is not worn — the base kit is, and the notes say why, so a typo in
 * someone's brand never ships unreadable text.
 *
 * I/O is injected (the harness passes fs), so this stays pure and runs where
 * there is no file system.
 */
import { type BrandFile, kitFromBrand, parseBrandMd } from './brand.ts';
import { DEFAULT_KIT_ID, kitById, kitOrDefault } from './kits.ts';
import type { Kit } from './schema.ts';
import { describeIssues } from './validate.ts';

/** Where a project keeps its brand, relative to the project folder. */
export const BRAND_FILE = '.bobble/brand.md';

export interface ProjectKit {
  readonly kit: Kit;
  /** Where it came from. */
  readonly source: 'brand' | 'setting' | 'default';
  /** What was changed or refused on the way, one sentence each. */
  readonly notes: readonly string[];
  /** The brand file's prose (its do's and don'ts), when there is one. */
  readonly prose?: string;
}

export async function loadProjectKit(opts: {
  /** The project (working) folder. */
  readonly root?: string;
  /** The Design setting's kit, when the setting is on. */
  readonly kitName?: string;
  readonly readFile?: (path: string) => Promise<string>;
}): Promise<ProjectKit> {
  const named = kitById(opts.kitName);
  const base = named ?? kitOrDefault(DEFAULT_KIT_ID);
  const notes: string[] = [];
  if (opts.kitName !== undefined && opts.kitName !== '' && named === undefined) {
    notes.push(`there is no kit called "${opts.kitName}"; ${base.name} is used`);
  }
  if (opts.root !== undefined && opts.root !== '' && opts.readFile !== undefined) {
    let text: string | null = null;
    try {
      text = await opts.readFile(`${opts.root.replace(/[\\/]+$/, '')}/${BRAND_FILE}`);
    } catch {
      text = null; // no brand file: the usual case
    }
    if (text !== null && text.trim() !== '') {
      const file: BrandFile = parseBrandMd(text);
      notes.push(...file.problems.map((p) => `${BRAND_FILE}: ${p}`));
      const made = kitFromBrand(file.brand, base);
      if (made.report.ok) {
        return {
          kit: made.kit,
          source: 'brand',
          notes: [...notes, ...made.notes],
          ...(file.prose !== '' ? { prose: file.prose } : {}),
        };
      }
      notes.push(
        `${BRAND_FILE} could not be made readable, so ${base.name} is used: ${describeIssues(made.report).split('\n').slice(0, 3).join('; ')}`,
      );
    }
  }
  return { kit: base, source: named !== undefined ? 'setting' : 'default', notes };
}
