/**
 * What goes with the question: one chip per piece of context, each saying what
 * it is in a few words, with a way to take it off.
 */
import {
  Glyph,
  IconClipboard,
  IconClose,
  IconFile,
  IconFolderOpen,
  IconGlobe,
  IconQuill,
} from '@pi-desktop/ui';
import type { JSX, ReactNode } from 'react';
import { contextLabel, type QuickContext } from '../../electron/quick/context';
import { type QuickAttachment, useQuickStore } from './quick-store';

function chipIcon(c: QuickContext, frontIcon: string | undefined): ReactNode {
  switch (c.kind) {
    case 'window':
      return <img className="qp-chip-thumb" src={c.image} alt="" />;
    case 'region':
      return <img className="qp-chip-thumb" src={c.image} alt="" />;
    case 'screen':
      return <img className="qp-chip-thumb" src={c.image} alt="" />;
    case 'clipboard':
      return c.image !== undefined ? (
        <img className="qp-chip-thumb" src={c.image} alt="" />
      ) : (
        <span className="qp-chip-icon">
          <IconClipboard size={15} />
        </span>
      );
    case 'selection':
      return (
        <span className="qp-chip-icon">
          {frontIcon !== undefined ? <img src={frontIcon} alt="" /> : <IconQuill size={15} />}
        </span>
      );
    case 'files':
      return (
        <span className="qp-chip-icon">
          <IconFolderOpen size={15} />
        </span>
      );
    case 'browser':
      return (
        <span className="qp-chip-icon">
          {frontIcon !== undefined ? <img src={frontIcon} alt="" /> : <IconGlobe size={15} />}
        </span>
      );
    case 'app':
      return (
        <span className="qp-chip-icon">
          {frontIcon !== undefined ? (
            <img src={frontIcon} alt="" />
          ) : (
            <Glyph name="computerUse" size={15} />
          )}
        </span>
      );
  }
}

function Chip({
  kind,
  icon,
  label,
  title,
  onRemove,
}: {
  kind: string;
  icon: ReactNode;
  label: string;
  title?: string;
  onRemove: () => void;
}): JSX.Element {
  return (
    <span
      className="qp-chip"
      data-kind={kind}
      data-testid={`quick-chip-${kind}`}
      title={title ?? label}
    >
      {icon}
      <span className="qp-chip-label">{label}</span>
      <button
        type="button"
        className="qp-chip-remove pd-focusable"
        aria-label={`Remove ${label}`}
        onClick={onRemove}
      >
        <IconClose size={11} />
      </button>
    </span>
  );
}

const CAPTURING_WORDS: Record<string, string> = {
  region: 'Drag over the part of the screen you mean',
  pick: 'Click the window you mean',
  screen: 'Looking at the screen',
  window: 'Looking at the window',
};

export function ContextChips(): JSX.Element | null {
  const contexts = useQuickStore((s) => s.contexts);
  const attachments = useQuickStore((s) => s.attachments);
  const capturing = useQuickStore((s) => s.capturing);
  const front = useQuickStore((s) => s.front);
  const remove = useQuickStore((s) => s.removeContext);
  const removeAttachment = useQuickStore((s) => s.removeAttachment);
  if (contexts.length === 0 && attachments.length === 0 && capturing === null) return null;
  const iconFor = (c: QuickContext): string | undefined =>
    (c.kind === 'selection' || c.kind === 'app' || c.kind === 'browser') &&
    front?.icon !== undefined
      ? front.icon
      : undefined;
  return (
    <div className="qp-chips" data-testid="quick-chips">
      {contexts.map((c) => (
        <Chip
          key={c.id}
          kind={c.kind}
          icon={chipIcon(c, iconFor(c))}
          label={contextLabel(c)}
          {...(c.kind === 'selection' ? { title: c.text.slice(0, 400) } : {})}
          onRemove={() => remove(c.id)}
        />
      ))}
      {attachments.map((a: QuickAttachment) => (
        <Chip
          key={a.id}
          kind="file"
          icon={
            a.image !== undefined ? (
              <img className="qp-chip-thumb" src={a.image} alt="" />
            ) : (
              <span className="qp-chip-icon">
                <IconFile size={15} />
              </span>
            )
          }
          label={a.name}
          onRemove={() => removeAttachment(a.id)}
        />
      ))}
      {capturing !== null ? (
        <span className="qp-capturing" role="status" data-testid="quick-capturing">
          <span className="qp-capturing-dot" />
          {CAPTURING_WORDS[capturing] ?? 'Capturing'}
        </span>
      ) : null}
    </div>
  );
}
