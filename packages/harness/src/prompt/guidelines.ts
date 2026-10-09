/**
 * THE GUIDELINES SAY WHOSE THEY ARE.
 *
 * pi assembles a "Guidelines:" block by concatenating every tool's
 * `promptGuidelines` as bare bullets. Read back in the Advanced panel that is:
 *
 *   - Make this your last action whenever the task produced a file …
 *   - Use it when the user describes work that repeats or should happen later …
 *   - Use it for a large, multi-part build that a single pass cannot do well …
 *
 * The user: "there's so much explanation which I can't figure out what it's
 * explaining about." Every "it" was a different tool — present, the scheduler,
 * the manager — and two of them were not even in the model's list.
 *
 * So the block is rebuilt: one line per tool, the tool NAMED, its bullets
 * joined; a tool the model does not currently have contributes nothing; pi's
 * own file-handling lines stay but lose the reference to tools this build
 * never registers. Pure — the prompt text in, the prompt text out.
 */

export interface GuidelineSource {
  readonly name: string;
  readonly guidelines: readonly string[];
}

export interface AttributeOptions {
  /** The tools the model actually has this turn. Others' guidance is dropped. */
  readonly active: ReadonlySet<string>;
  /** How to print a tool's name — a command in CLI mode. Default: backticked name. */
  readonly nameFor?: (tool: string) => string;
}

const HEADER = 'Guidelines:';

/** pi's exploration line names grep/find, which this build does not register. */
const EXPLORATION_LINE = /^Prefer grep\/find\/ls tools over bash/;

function normalize(s: string): string {
  return s.trim().replace(/\s+/g, ' ');
}

/**
 * Rewrite the "Guidelines:" block of `prompt`. A prompt without one is returned
 * unchanged; so is one whose bullets match no known tool (nothing to attribute).
 */
export function attributeGuidelines(
  prompt: string,
  sources: readonly GuidelineSource[],
  opts: AttributeOptions,
): string {
  const start = prompt.indexOf(`${HEADER}\n`);
  if (start < 0) return prompt;
  const bodyStart = start + HEADER.length + 1;
  // The block runs while lines are bullets (or their wrapped continuations).
  const lines = prompt.slice(bodyStart).split('\n');
  const bullets: string[] = [];
  let consumed = 0;
  for (const line of lines) {
    if (line.startsWith('- ')) {
      bullets.push(line.slice(2));
    } else if (line.startsWith('  ') && bullets.length > 0) {
      bullets[bullets.length - 1] = `${bullets[bullets.length - 1]} ${line.trim()}`;
    } else {
      break;
    }
    consumed += line.length + 1;
  }
  if (bullets.length === 0) return prompt;

  const owner = new Map<string, string>();
  for (const src of sources) {
    for (const g of src.guidelines) {
      const key = normalize(g);
      if (!owner.has(key)) owner.set(key, src.name);
    }
  }
  const nameFor = opts.nameFor ?? ((t: string): string => `\`${t}\``);

  const byTool = new Map<string, string[]>();
  const general: string[] = [];
  for (const b of bullets) {
    const tool = owner.get(normalize(b));
    if (tool === undefined) {
      if (EXPLORATION_LINE.test(b) && !opts.active.has('grep') && !opts.active.has('find')) {
        continue;
      }
      general.push(b);
      continue;
    }
    if (!opts.active.has(tool)) continue;
    const list = byTool.get(tool) ?? [];
    list.push(b);
    byTool.set(tool, list);
  }

  const out: string[] = [];
  for (const [tool, list] of byTool) out.push(`- ${nameFor(tool)}: ${list.join(' ')}`);
  for (const g of general) out.push(`- ${g}`);
  const rebuilt = `${HEADER}\n${out.join('\n')}`;
  return `${prompt.slice(0, start)}${rebuilt}${prompt.slice(bodyStart + consumed - 1)}`;
}
