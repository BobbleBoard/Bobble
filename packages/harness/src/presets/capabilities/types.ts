/**
 * What a capability is: a FIXED, named set of tools, turned on once, in one
 * call — see ../capabilities.ts for why a named group beats a search.
 */
export interface Capability {
  /** What the model asks for. Lowercase, hyphenated, guessable. */
  readonly name: string;
  /** One line: what it is FOR. Shown when the model lists capabilities. */
  readonly summary: string;
  /** When to reach for this one rather than a neighbour. */
  readonly guidance: string;
  readonly tools: readonly string[];
}
