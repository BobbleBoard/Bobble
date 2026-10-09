/**
 * The quick panel's message, folded the way the chat composer folds its own.
 *
 * electron/quick/context.ts says WHAT goes (its attachments and the tail); this
 * puts it together with the composer's `buildAgentMessage`, files dropped on the
 * panel included, so pi reads exactly the shape a chat sends — and a thread
 * opened in the main window rebuilds its bubbles with the same cards.
 */
import type { AssembledMessage } from '../../electron/quick/context';
import { buildAgentMessage, type TextFileAttachment } from '../chat/composer/agent-message';

export function composeAgentMessage(
  assembled: Pick<AssembledMessage, 'attachments' | 'tail'>,
  dropped: readonly TextFileAttachment[] = [],
): string {
  return buildAgentMessage(assembled.tail, [...assembled.attachments, ...dropped]);
}
