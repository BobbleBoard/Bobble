/**
 * EVERY QUESTION TO THE PERSON, IN ONE PLACE — a card the composer's width,
 * standing just above it.
 *
 * the user (2026-10-01, on the "Run this command?" modal over a blurred app): "let's
 * put this sort of permission popup just as a little card same width as the
 * input bar floating directly above it (not on top of), and make the 'ask user'
 * question modals and any user inputs from the model or for the chat just
 * appear there". So pi's blocking extension_ui_requests — a permission prompt,
 * a `confirm`, the harness `ask_user` tool's question (choice / multi / slider /
 * free text) and pi's native `select` / `input` / `editor` — all render here,
 * as one card in the composer slot: in the flow above the composer, so it never
 * covers the composer nor the last of the conversation, and no backdrop.
 *
 * Only the oldest pending ask for the chat on screen shows; a request raised by
 * a chat running in the BACKGROUND is tagged with its own sessionFile (see the
 * sink) and surfaces as a top banner + an orange dot instead. Where there is no
 * composer (a studio, the model hub, a subagent's view) the same card floats at
 * the foot of the window instead (`placement="floating"`). Fire-and-forget
 * requests (notify/setStatus/…) never reach here — the router handles them as
 * store mutations.
 */
import { Button, type QuestionAnswer, QuestionCard, type QuestionOption } from '@pi-desktop/ui';
import { type JSX, useId } from 'react';
import { respondUi } from '../state/pi-connect';
import { usePiStore } from '../state/pi-slice';
import { PermissionCard } from './PermissionCard';

/** The ask the person should see now: the oldest for the chat on screen, or null. */
export function useViewedAsk(): UiRequest | null {
  const viewed = usePiStore((s) => s.session?.sessionFile ?? null);
  return usePiStore(
    (s) =>
      s.uiRequests.find((r) => r.sessionFile === undefined || r.sessionFile === viewed) ?? null,
  );
}

export function AskCard({
  placement = 'composer',
}: {
  /** In the composer slot (the chat), or floating at the window's foot (no composer). */
  placement?: 'composer' | 'floating';
}): JSX.Element | null {
  const request = useViewedAsk();
  if (request === null) return null;
  const card = cardFor(request);
  if (placement === 'floating') {
    return (
      <div className="pointer-events-none fixed inset-x-0 bottom-10 z-40 flex justify-center px-4">
        <div className="pd-ask-slot pointer-events-auto w-full max-w-[700px]">{card}</div>
      </div>
    );
  }
  return (
    <div className="pd-ask-slot mx-auto w-full max-w-[700px]" data-testid="ask-slot">
      {card}
    </div>
  );
}

function cardFor(request: UiRequest): JSX.Element {
  const cancel = () => void respondUi(request.id, { cancelled: true });

  /*
   * A PERMISSION PROMPT — three answers and a preview of what it would do.
   *
   * The answer round-trips as the `input` request's string value, which is how
   * it crossed in the first place (pi's dialog protocol has no three-way
   * method). Anything the harness does not recognise is a refusal, so a
   * dismissed card can never become a yes.
   */
  if (request.method === 'permission' && request.permission !== undefined) {
    const spec = request.permission;
    return (
      <PermissionCard
        key={request.id}
        request={{ toolName: spec.toolName, reason: spec.reason, args: spec.args }}
        onAnswer={(answer) => void respondUi(request.id, { value: answer })}
      />
    );
  }

  // confirm — a plain yes/no (QuestionCard has no confirm mode).
  if (request.method === 'confirm') {
    return (
      <ConfirmCard
        key={request.id}
        title={request.title ?? 'Bobble needs your input'}
        message={request.message}
        onCancel={cancel}
        onConfirm={() => void respondUi(request.id, { confirmed: true })}
      />
    );
  }

  // Everything else → the QuestionCard. Skip (the card's cancel) dismisses it.
  return renderQuestionCard(request, cancel);
}

/** A yes/no ask (computer use for an app, Chrome scripting): Cancel or Confirm. */
function ConfirmCard({
  title,
  message,
  onCancel,
  onConfirm,
}: {
  title: string;
  message: string | undefined;
  onCancel: () => void;
  onConfirm: () => void;
}): JSX.Element {
  const titleId = useId();
  return (
    <section
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      className="pd-ask-card"
      data-testid="confirm-card"
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        e.stopPropagation();
        onCancel();
      }}
    >
      <div className="pd-ask-card-head">
        <h2 id={titleId} className="pd-ask-card-title">
          {title}
        </h2>
        {message !== undefined && message !== '' ? (
          <p className="pd-ask-card-reason">{message}</p>
        ) : null}
      </div>
      <div className="pd-ask-card-actions">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" onClick={onConfirm}>
          Confirm
        </Button>
      </div>
    </section>
  );
}

type UiRequest = NonNullable<ReturnType<typeof usePiStore.getState>['uiRequests'][number]>;

function renderQuestionCard(request: UiRequest, onCancel: () => void) {
  const title = request.title ?? 'Bobble needs your input';

  // The harness ask_user tool — a rich spec decoded by the event-router. The
  // answer round-trips back as the input's string value (JSON), which the tool
  // parses. multi-select maps to a multiple-choice QuestionCard.
  if (request.method === 'askUser' && request.ask !== undefined) {
    const spec = request.ask;
    const options: QuestionOption[] = (spec.options ?? []).map((o) => ({
      value: o.value,
      label: o.label,
      info: o.info,
    }));
    const mode = spec.mode === 'multi' ? 'choice' : spec.mode;
    return (
      <QuestionCard
        key={request.id}
        data-testid="question-card"
        question={spec.question}
        mode={mode}
        options={options}
        multiple={spec.mode === 'multi'}
        min={spec.min}
        max={spec.max}
        step={spec.step}
        defaultValue={spec.defaultValue}
        placeholder={spec.placeholder}
        submitLabel={spec.submitLabel}
        onSubmit={(answer: QuestionAnswer) =>
          void respondUi(request.id, { value: JSON.stringify(answer) })
        }
        onCancel={onCancel}
      />
    );
  }

  // pi native `select` — a single-choice list.
  if (request.method === 'select') {
    const options: QuestionOption[] = (request.options ?? []).map((o) => ({ value: o, label: o }));
    return (
      <QuestionCard
        key={request.id}
        data-testid="question-card"
        question={title}
        mode="choice"
        options={options}
        onSubmit={(answer: QuestionAnswer) => {
          // A picked option → its value; a free "reply directly" / "something
          // else" → the typed text.
          const value =
            answer.mode === 'choice'
              ? (answer.values[0] ?? '')
              : answer.mode === 'free'
                ? answer.text
                : '';
          void respondUi(request.id, { value });
        }}
        onCancel={onCancel}
      />
    );
  }

  // pi native `input` / `editor` — free text (editor prefills its contents).
  return (
    <QuestionCard
      key={request.id}
      data-testid="question-card"
      question={title}
      mode="free"
      placeholder={request.placeholder}
      defaultText={request.method === 'editor' ? (request.prefill ?? '') : ''}
      onSubmit={(answer: QuestionAnswer) => {
        const text = answer.mode === 'free' ? answer.text : '';
        void respondUi(request.id, { value: text });
      }}
      onCancel={onCancel}
    />
  );
}
