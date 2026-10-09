/**
 * "Allow this?" — with what it is about to do, and three answers.
 *
 * The prompt used to be `ctx.ui.confirm`: a title, a reason, the first 200
 * characters of the command, and two buttons. Two buttons is the problem —
 * "allow once" and "allow for this chat" are different decisions, so collapsing
 * them means either re-asking about the same command every single turn or
 * granting something for good on one click.
 *
 * AND IT SHOWED THE WRONG THING. For a write or an edit, the argument that
 * matters is the CONTENT, and a truncated JSON blob is not a preview. What a
 * person needs to decide is what changes.
 *
 * The three answers, and the preview, are the whole point of this file.
 */

import { Button } from '@pi-desktop/ui';
import { type JSX, useId } from 'react';

/** What the model wants to do, decoded from the harness's sentinel. */
export interface PermissionRequest {
  readonly toolName: string;
  readonly reason: string;
  readonly args: Record<string, unknown>;
}

/**
 * The one thing worth showing for this call.
 *
 * Not the whole argument object: for `bash` that is the command, for a write it
 * is the content, for an edit it is what is being replaced. A JSON dump of all
 * of it is what the old prompt did, and it is unreadable exactly when it
 * matters most.
 */
export interface Preview {
  readonly kind: 'command' | 'write' | 'edit' | 'none';
  /** A path, when the call names one. */
  readonly path?: string;
  readonly body: string;
}

const MAX_PREVIEW_CHARS = 4000;

function clip(text: string): string {
  return text.length > MAX_PREVIEW_CHARS
    ? `${text.slice(0, MAX_PREVIEW_CHARS)}\n…(${text.length - MAX_PREVIEW_CHARS} more characters)`
    : text;
}

export function previewFor(toolName: string, args: Record<string, unknown>): Preview {
  const str = (k: string): string | undefined =>
    typeof args[k] === 'string' ? (args[k] as string) : undefined;
  const path = str('path') ?? str('file_path');

  if (toolName === 'bash') {
    const command = str('command') ?? '';
    return { kind: 'command', body: clip(command) };
  }
  if (toolName === 'write') {
    const content = str('content') ?? str('text') ?? '';
    return {
      kind: 'write',
      ...(path !== undefined ? { path } : {}),
      // An overwrite is every line added, and saying so is honest — the old
      // general differ rendered it that way without explaining why.
      body: clip(content),
    };
  }
  if (toolName === 'edit') {
    const oldText = str('oldText') ?? str('old_string') ?? '';
    const newText = str('newText') ?? str('new_string') ?? '';
    if (oldText !== '' || newText !== '') {
      const lines = [
        ...oldText.split('\n').map((l) => `- ${l}`),
        ...newText.split('\n').map((l) => `+ ${l}`),
      ];
      return {
        kind: 'edit',
        ...(path !== undefined ? { path } : {}),
        body: clip(lines.join('\n')),
      };
    }
  }
  // Anything else: the arguments, formatted — better than nothing, and honest
  // about being a fallback rather than pretending to be a preview.
  const rest = JSON.stringify(args, null, 2);
  return { kind: 'none', ...(path !== undefined ? { path } : {}), body: clip(rest) };
}

/**
 * THE ASK, AS A CARD ABOVE THE COMPOSER — not a modal over a blurred app.
 * The user (2026-10-01): "let's put this sort of permission popup just as a little
 * card same width as the input bar floating directly above it (not on top of)".
 * It stands where the person is already looking, the conversation stays
 * readable above it, and Escape inside it is "Don't" (dismissing is not
 * permission). The test ids are the dialog's, so every probe still finds it.
 */
export function PermissionCard({
  request,
  onAnswer,
}: {
  request: PermissionRequest;
  /** 'once' | 'session' | 'deny' — the harness treats anything else as deny. */
  onAnswer: (answer: 'once' | 'session' | 'deny') => void;
}): JSX.Element {
  const preview = previewFor(request.toolName, request.args);
  const titleId = useId();
  return (
    <section
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      className="pd-ask-card"
      data-testid="permission-dialog"
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        e.stopPropagation();
        onAnswer('deny');
      }}
    >
      <div className="pd-ask-card-head">
        <h2 id={titleId} className="pd-ask-card-title">
          {titleFor(request.toolName)}
        </h2>
        {request.reason !== '' ? <p className="pd-ask-card-reason">{request.reason}</p> : null}
      </div>
      {preview.path !== undefined ? (
        <p className="pd-field-label" data-testid="permission-path">
          {preview.path}
        </p>
      ) : null}
      <pre className="pd-permission-preview" data-testid="permission-preview">
        {preview.body}
      </pre>
      <div className="pd-ask-card-actions">
        <Button variant="ghost" onClick={() => onAnswer('deny')} data-testid="permission-deny">
          Don't
        </Button>
        <Button
          variant="secondary"
          onClick={() => onAnswer('session')}
          data-testid="permission-session"
        >
          Allow in this chat
        </Button>
        <Button variant="primary" onClick={() => onAnswer('once')} data-testid="permission-once">
          Allow once
        </Button>
      </div>
    </section>
  );
}

function titleFor(toolName: string): string {
  switch (toolName) {
    case 'bash':
      return 'Run this command?';
    case 'write':
      return 'Write this file?';
    case 'edit':
      return 'Make this change?';
    default:
      return `Allow ${toolName}?`;
  }
}
