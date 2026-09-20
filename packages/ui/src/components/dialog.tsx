import { clsx } from 'clsx';
import { Dialog as RadixDialog } from 'radix-ui';
import type { ComponentPropsWithoutRef, HTMLAttributes, ReactNode } from 'react';
import { forwardRef, useEffect, useRef } from 'react';
import { IconClose } from './icons.tsx';

/**
 * Dialog — spec-dialog.md. One structure for both flavors; the motion tokens
 * select claude `zoom` (.95->1, 250/125ms asymmetric close) or codex `rise`
 * (8px + .98 from top origin, 300/150ms).
 */
export const Dialog = RadixDialog.Root;
export const DialogTrigger = RadixDialog.Trigger;
export const DialogClose = RadixDialog.Close;

export interface DialogContentProps extends ComponentPropsWithoutRef<typeof RadixDialog.Content> {
  /** Ghost close button in the top-right (claude header idiom). */
  showClose?: boolean;
}

export const DialogContent = forwardRef<HTMLDivElement, DialogContentProps>(function DialogContent(
  { showClose = true, className, children, onCloseAutoFocus, ...rest },
  ref,
) {
  /*
   * WHERE THE KEYBOARD GOES WHEN THE DIALOG CLOSES.
   *
   * Radix returns focus to the TRIGGER. A dialog opened programmatically has no
   * trigger — the auto-download prompt appears because the router found the
   * chosen tier isn't on disk, not because anyone clicked anything — so on close
   * there is nowhere to hand focus back to and it lands on <body>. MEASURED: send
   * the first message in a fresh profile, dismiss the prompt, and `activeElement`
   * is BODY. You are typing into nothing and have to click the composer again.
   *
   * So the dialog remembers where the keyboard was when it opened and puts it
   * back. Captured during the first render, which is the last moment before
   * Radix's focus scope moves it. There is no branch for the two cases because
   * there doesn't need to be one: when a trigger DID open the dialog, the trigger
   * is what was focused, so restoring "where it was" and Radix's own behaviour
   * are the same thing.
   */
  const cameFrom = useRef<Element | null>(null);
  if (cameFrom.current === null) cameFrom.current = document.activeElement;

  /** Puts the keyboard back. Returns whether it had somewhere to put it. */
  const restoreFocus = (): boolean => {
    const prev = cameFrom.current;
    // Only when it's still on the page: a dialog whose opener was removed while
    // it was up has nothing to go back to. And never <body> — "restoring" focus
    // to the body is what this exists to prevent.
    if (!(prev instanceof HTMLElement) || !prev.isConnected || prev === document.body) return false;
    prev.focus();
    return true;
  };

  /*
   * THE SECOND PATH, and the one that was actually happening here.
   *
   * `onCloseAutoFocus` only fires when Radix CLOSES the dialog. A dialog whose
   * open state is derived from the data it shows is not closed, it is DESTROYED:
   * AutoDownloadPrompt renders `null` the moment the pending download is
   * dismissed, so the whole Radix tree unmounts in the same commit and the close
   * path never runs at all. That is a normal way to write a data-driven dialog
   * and it should not cost the user their keyboard.
   *
   * So unmount restores too, guarded on nothing else having claimed focus in the
   * meantime: after this component is gone, if the keyboard is nowhere, put it
   * back where it came from. Deferred by a microtask because the cleanup runs
   * BEFORE React removes the nodes, and focusing an element that is about to be
   * detached from is how you end up back on <body> anyway.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: restoreFocus only reads a ref, so it is stable by construction; this must run on unmount alone.
  useEffect(() => {
    return () => {
      queueMicrotask(() => {
        const now = document.activeElement;
        if (now === null || now === document.body) restoreFocus();
      });
    };
  }, []);

  return (
    <RadixDialog.Portal>
      <RadixDialog.Overlay className="pd-dialog-overlay" />
      <RadixDialog.Content
        ref={ref}
        className={clsx('pd-dialog', className)}
        onCloseAutoFocus={(event) => {
          onCloseAutoFocus?.(event);
          if (event.defaultPrevented) return;
          // Leave Radix's own fallback in place when there is nothing to go back
          // to, rather than preventing it and landing on <body> deliberately.
          if (restoreFocus()) event.preventDefault();
        }}
        {...rest}
      >
        {children}
        {showClose ? (
          <RadixDialog.Close asChild>
            <button
              type="button"
              className="pd-btn pd-btn--ghost-muted pd-icon-btn pd-btn--sm"
              aria-label="Close"
              style={{ position: 'absolute', top: 12, right: 12 }}
            >
              <IconClose />
            </button>
          </RadixDialog.Close>
        ) : null}
      </RadixDialog.Content>
    </RadixDialog.Portal>
  );
});

export const DialogHeader = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function DialogHeader({ className, ...rest }, ref) {
    return <div ref={ref} className={clsx('pd-dialog-header', className)} {...rest} />;
  },
);

export const DialogTitle = forwardRef<
  HTMLHeadingElement,
  ComponentPropsWithoutRef<typeof RadixDialog.Title>
>(function DialogTitle({ className, ...rest }, ref) {
  return <RadixDialog.Title ref={ref} className={clsx('pd-dialog-title', className)} {...rest} />;
});

export const DialogDescription = forwardRef<
  HTMLParagraphElement,
  ComponentPropsWithoutRef<typeof RadixDialog.Description>
>(function DialogDescription({ className, ...rest }, ref) {
  return (
    <RadixDialog.Description
      ref={ref}
      className={clsx('pd-dialog-description', className)}
      {...rest}
    />
  );
});

export const DialogBody = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function DialogBody({ className, ...rest }, ref) {
    return <div ref={ref} className={clsx('pd-dialog-body pd-scroll', className)} {...rest} />;
  },
);

export const DialogFooter = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function DialogFooter({ className, ...rest }, ref) {
    return <div ref={ref} className={clsx('pd-dialog-footer', className)} {...rest} />;
  },
);

export interface DialogFieldProps extends HTMLAttributes<HTMLDivElement> {
  /** The control's id, so the label reaches it for a screen reader. */
  htmlFor?: string;
  label: ReactNode;
  /** One line under the control: what goes here, or what it will become. */
  hint?: ReactNode;
  /** Replaces the hint while there is something wrong with the value. */
  error?: ReactNode;
  /** The one field the dialog is about: a size up, on the inset surface. */
  hero?: boolean;
}

/**
 * A labelled control in a dialog: label over control over hint, on the
 * dialog's own type steps (dialog.css). The label is a real <label> when it
 * has a control to point at; a group of controls (a row of selects) gets a
 * plain caption instead.
 */
export const DialogField = forwardRef<HTMLDivElement, DialogFieldProps>(function DialogField(
  { htmlFor, label, hint, error, hero = false, className, children, ...rest },
  ref,
) {
  return (
    <div ref={ref} className={clsx('pd-field', hero && 'pd-field--hero', className)} {...rest}>
      {htmlFor !== undefined ? (
        <label className="pd-field-label" htmlFor={htmlFor}>
          {label}
        </label>
      ) : (
        <span className="pd-field-label">{label}</span>
      )}
      {children}
      {error !== undefined && error !== null && error !== false ? (
        <span className="pd-field-error" role="alert">
          {error}
        </span>
      ) : hint !== undefined && hint !== null && hint !== false ? (
        <span className="pd-field-hint">{hint}</span>
      ) : null}
    </div>
  );
});

/** Fields side by side (each as wide as its controls), wrapping when narrow. */
export const DialogFieldRow = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function DialogFieldRow({ className, ...rest }, ref) {
    return <div ref={ref} className={clsx('pd-field-row', className)} {...rest} />;
  },
);

export interface DialogSummaryProps extends HTMLAttributes<HTMLDivElement> {
  /** A glyph for what kind of thing will happen (a clock, a download…). */
  icon?: ReactNode;
  /** The consequence, in a sentence; <strong> the parts that matter. */
  children: ReactNode;
  /** The quieter second line: the caveats. */
  note?: ReactNode;
}

/**
 * What will happen when the primary button is pressed — the schedule and its
 * first run, the size of a download — on the inset surface between the
 * fields and the buttons, so a person reads the consequence before the
 * action.
 */
export const DialogSummary = forwardRef<HTMLDivElement, DialogSummaryProps>(function DialogSummary(
  { icon, children, note, className, ...rest },
  ref,
) {
  return (
    <div ref={ref} className={clsx('pd-dialog-summary', className)} {...rest}>
      {icon !== undefined ? <span className="pd-dialog-summary-icon">{icon}</span> : null}
      <div className="pd-dialog-summary-text">
        <p className="pd-dialog-summary-main">{children}</p>
        {note !== undefined && note !== null && note !== false ? (
          <p className="pd-dialog-summary-note">{note}</p>
        ) : null}
      </div>
    </div>
  );
});

export type CurtainProps = HTMLAttributes<HTMLDivElement>;

/**
 * Curtain — app-level blocking scrim (codex pattern, adopted for both flavors
 * per spec-dialog ADAPTATION; use for model downloads etc.).
 */
export const Curtain = forwardRef<HTMLDivElement, CurtainProps>(function Curtain(
  { className, ...rest },
  ref,
) {
  return <div ref={ref} className={clsx('pd-curtain', className)} {...rest} />;
});
