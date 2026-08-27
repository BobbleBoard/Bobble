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

import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@pi-desktop/ui';
import type { JSX } from 'react';

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

export function PermissionDialog({
  request,
  onAnswer,
}: {
  request: PermissionRequest;
  /** 'once' | 'session' | 'deny' — the harness treats anything else as deny. */
  onAnswer: (answer: 'once' | 'session' | 'deny') => void;
}): JSX.Element {
  const preview = previewFor(request.toolName, request.args);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        // Dismissing is not permission. The harness defaults the same way, so a
        // closed dialog can never become a yes.
        if (!open) onAnswer('deny');
      }}
    >
      <DialogContent data-testid="permission-dialog" className="max-w-[620px]">
        <DialogHeader>
          <DialogTitle>{titleFor(request.toolName)}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <p className="text-body text-text-secondary">{request.reason}</p>
          {preview.path !== undefined ? (
            <p className="text-caption text-text-muted" data-testid="permission-path">
              {preview.path}
            </p>
          ) : null}
          <pre className="pd-permission-preview" data-testid="permission-preview">
            {preview.body}
          </pre>
        </div>
        <DialogFooter>
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
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
