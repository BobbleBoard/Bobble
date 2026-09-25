/**
 * The two things the chat's markdown renderer needs to draw citations — the
 * component for the `pd-cite` element, and the tree pass that makes those
 * elements (bound to the turn's sources by `useCitationRehype`). Kept here so
 * the renderer's own file gains a line, not a feature.
 */
import type { ComponentType } from 'react';
import { CiteElement } from './CitationChip';
import { CITE_TAG } from './rehype-citations';
import './sources.css';

export { useCitationRehype } from './turn-sources';

/**
 * Merged into the renderer's `components`. `pd-cite` is not an HTML element,
 * so it is outside react-markdown's `Components` type — the runtime looks the
 * tag up by name all the same.
 */
export const CITATION_COMPONENTS = { [CITE_TAG]: CiteElement } as Record<
  string,
  ComponentType<{ node?: { properties?: Record<string, unknown> } }>
>;
