/**
 * Streamed conversation view: renders pi-slice `messages` through the design
 * system. Consecutive assistant messages with NO user turn between them (pi
 * models each agentic iteration as its own message) are merged into ONE
 * response unit so their tool/thinking runs collapse into a single Activity
 * CHAIN (THEME 3). User bubbles, assistant text (markdown), standalone
 * thoughts, inline generated images (round-5 #7), the response speed shown as a
 * message-action-bar item (Wave B #2 — the pinned tok/s footnote was removed;
 * the raw model-id footnote earlier, #11), the ONE consolidated live status
 * indicator ({@link ThreadStatusIndicator}, the user blind-test #1) while streaming,
 * inline artifact widgets (THEME 2), and auto-scroll.
 */

import { useCanvasTabs } from '@pi-desktop/canvas';
import type {
  AssistantMsg,
  BashExecMsg,
  ChatMsg,
  ContentBlock,
  NoticeMsg,
  ToolResultMsg,
  UserMsg,
} from '@pi-desktop/engine';
import {
  ActivityRow,
  BranchSwitcher,
  EditableMessage,
  IconChevronDown,
  IconTerminal,
  MessageActions,
  MessageRow,
  PresentCard,
  ScrollArea,
  Spinner,
  Thread,
  writeClipboardText,
} from '@pi-desktop/ui';
import { Fragment, type ReactNode, useEffect, useRef, useState } from 'react';
import { IconWarning } from '../settings/icons';
import { useCorpStore } from '../state/corp-store';
import { useLlmStore } from '../state/llm-store';
import { forkAndReprompt, switchBranch } from '../state/pi-connect';
import { usePiStore } from '../state/pi-slice';
import { openPresented, type PresentedRecord, usePresentStore } from '../state/present-store';
import { AssistantGroup } from './AssistantGroup';
import { AttachedFileCard } from './AttachedFileCard';
import { type AttachedFile, splitAttachedFiles } from './attached-files';
import { buildAgentMessage } from './composer/agent-message';
import { useDropStore } from './composer/drop-store';
import { corpChatView } from './corp/corp-thread-view';
import { HarnessChecklistPanel, ThreadStatusIndicator } from './HarnessStatus';
import { HistoryPole } from './HistoryPole';
import { BlindImageNote, UserImage } from './UserImage';

/**
 * How far from the bottom counts as "away", for the jump-to-latest control.
 *
 * Generous next to the 16 px stick threshold on purpose: the stick asks "should
 * I follow?" and wants to be strict, while this asks "is there anything below
 * worth a button?" and should not blink on and off during a stream.
 */
const JUMP_THRESHOLD_PX = 120;

/** Concatenated visible text of an assistant response group (for copy). */
function groupPlainText(group: AssistantMsg[]): string {
  return group
    .flatMap((m) => m.blocks)
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

/** One rendered row in the thread. */
type RenderItem =
  | { kind: 'user'; message: UserMsg }
  | { kind: 'bash'; message: BashExecMsg }
  | { kind: 'orphanTool'; message: ToolResultMsg }
  | { kind: 'notice'; message: NoticeMsg }
  | { kind: 'assistant'; group: AssistantMsg[] };

/**
 * The id a presented card anchors to for this row: the LAST message it draws,
 * so a card handed over at the end of an assistant group lands under the whole
 * group rather than splitting it.
 */
function threadItemId(item: RenderItem): string {
  return item.kind === 'assistant'
    ? (item.group[item.group.length - 1]?.id ?? '')
    : item.message.id;
}

/** Coalesce consecutive assistant messages (no user turn between) into groups. */
function toRenderItems(messages: ChatMsg[], claimed: Set<string>): RenderItem[] {
  const items: RenderItem[] = [];
  let group: AssistantMsg[] = [];
  const flush = () => {
    if (group.length > 0) items.push({ kind: 'assistant', group });
    group = [];
  };
  for (const m of messages) {
    if (m.kind === 'assistant') {
      group.push(m);
      continue;
    }
    // A claimed tool result belongs to the in-flight response (pi interleaves
    // result rows between the agent-iteration messages) — it must NOT split the
    // group, or each iteration's tool would render as its own chain.
    if (m.kind === 'toolResult' && claimed.has(m.toolCallId)) continue;
    flush();
    if (m.kind === 'user') items.push({ kind: 'user', message: m });
    else if (m.kind === 'bashExec') items.push({ kind: 'bash', message: m });
    else if (m.kind === 'toolResult') items.push({ kind: 'orphanTool', message: m });
    else if (m.kind === 'notice') items.push({ kind: 'notice', message: m });
  }
  flush();
  return items;
}

/** Lines of a user message shown before it is folded behind "Show more". */
const USER_CLAMP_LINES = 12;

/**
 * A long user message, folded.
 *
 * the user: "some of these messages are really really long, keep user message
 * bubbles short with a 'show more'." A pasted spec can be hundreds of lines,
 * and it pushes the reply — the thing being looked for — off the screen.
 * Short ones are untouched: a fold on three lines is worse than no fold.
 */
function ClampedText({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const lines = text.split('\n');
  const long = lines.length > USER_CLAMP_LINES || text.length > 1200;
  if (!long || open) {
    return (
      <span className="whitespace-pre-wrap">
        {text}
        {long ? (
          <button
            type="button"
            className="pd-usermsg-more pd-focusable"
            onClick={() => setOpen(false)}
          >
            Show less
          </button>
        ) : null}
      </span>
    );
  }
  const shown = lines.slice(0, USER_CLAMP_LINES).join('\n').slice(0, 1200);
  return (
    <span className="whitespace-pre-wrap">
      {shown}
      {'…'}
      <button type="button" className="pd-usermsg-more pd-focusable" onClick={() => setOpen(true)}>
        Show more
      </button>
    </span>
  );
}

/**
 * A generation rate we are willing to print.
 *
 * the user, on a footer reading "~13888 tok/s": "suspiciously incorrect". It is — no
 * local model decodes at five figures. That number is a PROMPT-processing rate,
 * which llama.cpp reports in the same timing block and in the same units, so a
 * stray parse or a prefill-only request surfaces it as though it were throughput.
 *
 * Rather than print a figure that is certainly wrong, print nothing. The reading
 * is a nicety; a wrong one actively misleads, and it is exactly the kind of number
 * a person would go on to make a decision with. The ceiling is deliberately loose
 * — far above any real local decode rate on this hardware, so a genuinely fast
 * model is never censored.
 */
const MAX_PLAUSIBLE_TPS = 1000;

function plausibleTps(tps: number | undefined): number | undefined {
  if (tps === undefined || !Number.isFinite(tps)) return undefined;
  if (tps <= 0 || tps > MAX_PLAUSIBLE_TPS) return undefined;
  return tps;
}

export function ChatThread() {
  const messages = usePiStore((s) => s.messages);
  const queuedSends = usePiStore((s) => s.queuedSends);
  const runningToolCalls = usePiStore((s) => s.runningToolCalls);
  const historyTruncated = usePiStore((s) => s.historyTruncated);
  const branches = usePiStore((s) => s.branches);
  const tps = useLlmStore((s) => s.status.metrics?.avgTps ?? s.status.metrics?.lastTps);

  // EXPERIMENTAL production harness: while a corp run is live, the model's output
  // streams INLINE after the user's prompt. The prompt bubble stays; the chat is
  // never blanked or taken over. `corpChatView` (pure) decides what to render: a
  // PINNED subagent's stream, else — once the team forms (promoted) — the CEO
  // "Waiting for N subagents to finish" indicator (the DEFAULT promoted view, NOT
  // an auto-followed leaf), else the pre-promotion solo CEO/root stream.
  const corpTaskId = useCorpStore((s) => s.taskId);
  const corpSituation = useCorpStore((s) => s.situation);
  const corpLiveNode = useCorpStore((s) => s.liveNode);
  const corpPinnedNode = useCorpStore((s) => s.pinnedNode);
  const corpView = corpChatView({
    taskId: corpTaskId,
    situation: corpSituation,
    liveNode: corpLiveNode,
    pinnedNode: corpPinnedNode,
  });
  const { controller: canvasController } = useCanvasTabs();
  const presented = usePresentStore((st) => st.items);

  const [editingId, setEditingId] = useState<string | null>(null);
  /*
   * THE FILES ON THE MESSAGE YOU ARE EDITING.
   *
   * Editing used to re-send the visible TEXT alone. A message's attachments live
   * in pi's copy (folded in as fenced blocks), so correcting a typo silently
   * deleted every file on the turn — and there was no way to add one either,
   * short of abandoning the edit and typing the whole message again.
   *
   * Seeded from the message when the edit opens, mutated by the ✕ on each card
   * and by "Add files", and folded back into pi's copy on save.
   */
  const [editFiles, setEditFiles] = useState<readonly AttachedFile[]>([]);
  const editFileInput = useRef<HTMLInputElement>(null);

  /** Open the editor on a message, seeded with its current attachments. */
  const beginEdit = (message: { id: string; text: string; agentText?: string }): void => {
    setEditFiles(splitAttachedFiles(message.agentText ?? message.text).files);
    setEditingId(message.id);
  };

  /** Read chosen files as text attachments (binaries are skipped, as elsewhere). */
  const addEditFiles = async (files: readonly File[]): Promise<void> => {
    const read = await Promise.all(
      files.map(
        (file) =>
          new Promise<AttachedFile | null>((resolve) => {
            const reader = new FileReader();
            reader.onerror = () => resolve(null);
            reader.onload = () => {
              const text = typeof reader.result === 'string' ? reader.result : '';
              // A NUL byte is the same binary test the read channel uses; a
              // binary pasted into a prompt is noise, not content.
              resolve(
                text.includes('\u0000') ? null : { id: crypto.randomUUID(), name: file.name, text },
              );
            };
            reader.readAsText(file);
          }),
      ),
    );
    const kept = read.filter((f): f is AttachedFile => f !== null);
    if (kept.length > 0) setEditFiles((prev) => [...prev, ...kept]);
  };

  /*
   * A DROP LANDS IN THE MESSAGE YOU ARE EDITING. the user: "drag and drop needs to
   * be able to go into messages being edited."
   *
   * The window-level overlay accepts a drop anywhere and hands the files to
   * whoever is composing. That was always the composer; while an edit is open,
   * the thing you are composing is this turn. The claim is released when the
   * edit closes, so the composer gets its drops back with nothing to remember.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: addEditFiles only calls setState; re-claiming on every render would churn the store
  useEffect(() => {
    if (editingId === null) return;
    return useDropStore.getState().claimDrops((files) => void addEditFiles(files));
  }, [editingId]);

  /* One card, wherever it is drawn — anchored to its turn or at the foot. */
  const renderPresented = (records: readonly PresentedRecord[]): ReactNode => (
    <div className="flex flex-col gap-2 px-1 pt-2" data-testid="presented">
      {records.map((item) => (
        <PresentCard
          key={item.path}
          item={item}
          /* Body → the canvas. Split button → an application. Two
           * different verbs, deliberately not sharing a handler. */
          onActivate={() => void openPresented(canvasController, item)}
          onOpen={() => {
            void window.piDesktop.invoke('canvas:open-default', { path: item.path });
          }}
          onOpenWith={(_it, appId) => {
            void window.piDesktop.invoke('canvas:open-with', { path: item.path, appId });
          }}
          onReveal={() => {
            void window.piDesktop.invoke('canvas:reveal', { path: item.path });
          }}
        />
      ))}
    </div>
  );

  const copyText = (text: string) => {
    void writeClipboardText(text);
  };
  // Retry: re-run the user turn that preceded this assistant response as a NEW BRANCH
  // — exactly like editing + resending that turn (forkAndReprompt), so the response
  // becomes an alternate the BranchSwitcher surfaces. (Previously it called sendPrompt,
  // which appended a DUPLICATE user message instead of branching.)
  const retryFrom = (firstAssistantId: string) => {
    const idx = messages.findIndex((m) => m.id === firstAssistantId);
    for (let i = idx - 1; i >= 0; i--) {
      const m = messages[i];
      if (m?.kind === 'user') {
        void forkAndReprompt(m.id, m.text);
        return;
      }
    }
  };
  // Inline edit (round-3 #A9): clicking Edit flips THAT user bubble into an
  // editable textarea (EditableMessage). Saving FORKS a new pi branch at that
  // message (pi:fork/pi:get-fork-messages) and streams the edited turn into it,
  // so the message now carries alternates surfaced by the BranchSwitcher below.
  const saveEdit = (text: string) => {
    const id = editingId;
    const files = editFiles;
    setEditingId(null);
    setEditFiles([]);
    if (id === null) return;
    // The bubble shows the typed text; pi receives it with the (possibly
    // edited) attachments folded back in — see forkAndReprompt's `agentMessage`.
    const body = buildAgentMessage(text, files);
    void forkAndReprompt(id, text, body === text ? undefined : body);
  };

  const scrollRef = useRef<HTMLDivElement>(null);
  // Autoscroll "stick": true only while the user is parked at the bottom. It is
  // released the instant the user scrolls UP (free-scroll during generation,
  // round-8) and re-armed only when they return to the bottom — so a burst of
  // streaming re-renders can never yank the view back down while they read above.
  const pinnedRef = useRef(true);

  // Re-arm the stick only when genuinely back at the bottom (tight threshold so
  // scrolling even slightly up stays released).
  const onScroll = () => {
    const el = scrollRef.current;
    if (el === null) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 16;
    syncAway();
  };

  // Release the stick on any explicit upward intent BEFORE the next streaming
  // render can re-pin. Wheel/touch/keys fire ahead of the scroll event — which
  // is exactly where the old snap-back race lived — so releasing here lets the
  // user scroll up freely and STAY there mid-generation.
  useEffect(() => {
    const el = scrollRef.current;
    if (el === null) return;
    const releaseUp = () => {
      pinnedRef.current = false;
    };
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) releaseUp();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowUp' || e.key === 'PageUp' || e.key === 'Home') releaseUp();
    };
    let lastY = 0;
    const onTouchStart = (e: TouchEvent) => {
      lastY = e.touches[0]?.clientY ?? 0;
    };
    const onTouchMove = (e: TouchEvent) => {
      const y = e.touches[0]?.clientY ?? 0;
      if (y > lastY + 1) releaseUp(); // finger drags down → content moves up
      lastY = y;
    };
    el.addEventListener('wheel', onWheel, { passive: true });
    el.addEventListener('keydown', onKey);
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: true });
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('keydown', onKey);
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
    };
  }, []);

  /*
   * THE WAY BACK DOWN.
   *
   * Releasing the stick is deliberately easy — one upward wheel tick, an arrow
   * key, a touch drag — and until now there was no way to re-arm it except
   * scrolling all the way to the bottom by hand. Someone who glanced up during a
   * long generation had to chase the stream down to get it following again.
   *
   * Mirrored into state (the stick itself stays a ref, so a streaming render
   * never re-runs on it) and only while there is somewhere to go: `away` is
   * false at the bottom, so the control appears exactly when it is useful.
   */
  const [away, setAway] = useState(false);
  const syncAway = (): void => {
    const el = scrollRef.current;
    if (el === null) return;
    setAway(el.scrollHeight - el.scrollTop - el.clientHeight > JUMP_THRESHOLD_PX);
  };
  const jumpToLatest = (): void => {
    const el = scrollRef.current;
    if (el === null) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    pinnedRef.current = true;
    setAway(false);
  };

  // Keep the newest content in view ONLY while pinned (never fights a scroll-up).
  useEffect(() => {
    const el = scrollRef.current;
    if (el !== null && pinnedRef.current) el.scrollTop = el.scrollHeight;
    // Streaming grows the content, so "am I away from the bottom" changes
    // without anyone scrolling.
    syncAway();
  });

  // Index tool results by both the assistant-scoped id and the bare callId so a
  // tool call finds its result whether streamed live or rehydrated.
  const resultByCallId = new Map<string, ToolResultMsg>();
  const claimed = new Set<string>();
  for (const m of messages) {
    if (m.kind === 'assistant') {
      for (const b of m.blocks) if (b.type === 'toolCall') claimed.add(b.id);
    }
  }
  for (const m of messages) {
    if (m.kind === 'toolResult') {
      resultByCallId.set(m.toolCallId, m);
      if (m.assistantId !== undefined) resultByCallId.set(`${m.assistantId}:${m.toolCallId}`, m);
    }
  }

  // User-message ordinal (0-based among user messages) — the key the fork
  // registry uses to attach a BranchSwitcher to the right bubble.
  const userOrdinalById = new Map<string, number>();
  {
    let n = -1;
    for (const m of messages) if (m.kind === 'user') userOrdinalById.set(m.id, ++n);
  }

  const items = toRenderItems(messages, claimed);
  /*
   * Presented artefacts, bucketed by the row they were handed over after. A
   * record whose anchor is not in this thread (presented before the first
   * message, or its turn edited away) has nowhere to sit and falls to the foot.
   */
  const anchorIds = new Set(items.map(threadItemId));
  const presentedByAnchor = new Map<string, PresentedRecord[]>();
  const orphanPresented: PresentedRecord[] = [];
  for (const record of presented) {
    const id = record.afterMessageId;
    if (id === null || !anchorIds.has(id)) {
      orphanPresented.push(record);
      continue;
    }
    const bucket = presentedByAnchor.get(id);
    if (bucket === undefined) presentedByAnchor.set(id, [record]);
    else bucket.push(record);
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {/* The live task checklist stays pinned above the scrolling transcript so
          the user watches items flip pending → in_progress → done during a task. */}
      <HarnessChecklistPanel />
      {/* The file picker "Add files" opens while editing a message. Hidden and
          always mounted, so the click that opens it stays a user gesture. */}
      <input
        ref={editFileInput}
        type="file"
        multiple
        hidden
        data-testid="edit-file-input"
        onChange={(e) => {
          void addEditFiles(Array.from(e.target.files ?? []));
          e.target.value = '';
        }}
      />
      {/* The jump-to line down the right edge of a LONG thread. It draws
          nothing at all until the conversation is long enough to get lost in —
          see history-pole.ts for what "long enough" means and why. */}
      <HistoryPole scrollRef={scrollRef} revision={messages.length} />
      <ScrollArea
        ref={scrollRef}
        onScroll={onScroll}
        className="pd-elastic-scroll min-h-0 flex-1"
        data-testid="chat-scroll"
      >
        <Thread>
          {historyTruncated ? (
            <div className="pb-2 text-center text-footnote text-text-muted">
              Earlier messages were truncated when this session was restored.
            </div>
          ) : null}

          {items.map((item) => {
            /*
             * A PRESENTED ARTEFACT STAYS WHERE IT WAS HANDED OVER.
             *
             * the user: "file presentation cards seem pinned to the bottom of the
             * chat for some time instead of staying at the position they were
             * created at." Every card ever presented used to render as one block
             * after the last message, so the picture from your first question was
             * still hovering over the composer three questions later. Each record
             * carries the message it followed (present-store's `afterMessageId`),
             * and the card is drawn there; anything whose anchor is not in this
             * thread still falls to the foot, which is where it used to live.
             */
            const cards = presentedByAnchor.get(threadItemId(item));
            const node = ((): ReactNode => {
              if (item.kind === 'notice') {
                /* The harness saying something the user needs — a model too small
                 for the work it just reached for, a failed verify, a loop-guard
                 steer. It sits with the turn it describes rather than sliding
                 past as a toast. */
                return (
                  <div key={item.message.id} className="pd-notice" data-testid="chat-notice">
                    <IconWarning size={14} className="pd-notice-icon" />
                    <span>{item.message.text}</span>
                  </div>
                );
              }
              if (item.kind === 'user') {
                const message = item.message;
                const ordinal = userOrdinalById.get(message.id) ?? -1;
                const group = branches[ordinal];
                // A message with alternates shows a persistent ‹ n / m › switcher
                // beneath its bubble (kept out of the hover-only action bar so the
                // alternates are always discoverable).
                const switcher =
                  group !== undefined && group.files.length > 1 ? (
                    <div className="flex justify-end">
                      <BranchSwitcher
                        data-testid="branch-switcher"
                        index={group.active}
                        total={group.files.length}
                        onPrev={() => void switchBranch(ordinal, group.active - 1)}
                        onNext={() => void switchBranch(ordinal, group.active + 1)}
                      />
                    </div>
                  ) : null;

                // Inline edit mode: the bubble becomes an editable textarea (#A9).
                if (editingId === message.id) {
                  return (
                    <div
                      key={message.id}
                      className="flex flex-col gap-1"
                      data-user-turn={message.id}
                    >
                      <EditableMessage
                        data-testid="editing-message"
                        // The TYPED text, without the folded attachments — those
                        // are cards above the field, not prose to edit around.
                        value={splitAttachedFiles(message.agentText ?? message.text).text}
                        editing
                        onSave={saveEdit}
                        onCancel={() => {
                          setEditingId(null);
                          setEditFiles([]);
                        }}
                        onAddFiles={() => editFileInput.current?.click()}
                        attachments={
                          editFiles.length > 0
                            ? editFiles.map((f) => (
                                <AttachedFileCard
                                  key={f.id}
                                  name={f.name}
                                  text={f.text}
                                  onRemove={() =>
                                    setEditFiles((prev) => prev.filter((x) => x.id !== f.id))
                                  }
                                />
                              ))
                            : undefined
                        }
                      />
                      {switcher}
                    </div>
                  );
                }
                /*
                 * THE PASTE CARD SURVIVES THE ROUND TRIP.
                 *
                 * the user: "pasted content shows literally as 'pasted content' rather
                 * than the already-designed paste card." Live, the bubble echoes
                 * only what was typed — but pi's copy of the message carries the
                 * attachments folded in as fenced blocks, and a chat REOPENED from
                 * its session file rebuilds its bubbles from that. So the card was
                 * right until you came back to the chat, and then it was a wall of
                 * "Attached file `pasted content`: ```". Unfolding here puts the
                 * cards back wherever the bubble came from.
                 */
                // pi's copy carries the fold; the visible text does not. Reading
                // `agentText` first makes a live bubble and a reloaded one show
                // the same cards (see UserMsg.agentText).
                const attached = splitAttachedFiles(message.agentText ?? message.text);
                return (
                  /* `data-user-turn` marks the thread's landmarks for the
                     history pole — the one place that knows where each question
                     is on the page. See history-pole.ts. */
                  <div key={message.id} className="flex flex-col gap-1" data-user-turn={message.id}>
                    <MessageRow
                      kind="user"
                      actions={
                        <MessageActions
                          onCopy={() => copyText(message.text)}
                          onEdit={() => beginEdit(message)}
                        />
                      }
                    >
                      <div className="flex flex-col gap-2">
                        {message.images !== undefined && message.images.length > 0 ? (
                          <>
                            <div className="flex flex-wrap gap-2">
                              {message.images.map((src) => (
                                <UserImage key={src} src={src} />
                              ))}
                            </div>
                            {/*
                              WORDS, NOT ONLY A COLOURED MARK. The tester: "a
                              coloured mark whose meaning I have to be taught is
                              the 'No project' chip all over again — right
                              instinct, and you're one sentence from it being
                              right." The badge on the picture catches the eye;
                              this says what it means, permanently, under the
                              message it belongs to.
                            */}
                            <BlindImageNote />
                          </>
                        ) : null}
                        {attached.files.length > 0 ? (
                          <div className="flex flex-wrap gap-2" data-testid="user-attachments">
                            {attached.files.map((f) => (
                              <AttachedFileCard key={f.id} name={f.name} text={f.text} />
                            ))}
                          </div>
                        ) : null}
                        {attached.text.length > 0 ? <ClampedText text={attached.text} /> : null}
                      </div>
                    </MessageRow>
                    {switcher}
                  </div>
                );
              }

              if (item.kind === 'assistant') {
                const group = item.group;
                const first = group[0];
                if (first === undefined) return null;
                const _totalTokens = [...group].reverse().find((m) => m.usage !== undefined)
                  ?.usage?.totalTokens;
                const streaming = group.some((m) => m.isStreaming === true);
                // Pre-first-token: an EMPTY streaming assistant would render a bare row
                // with the copy/retry (+tps) action bar next to the processing ring
                // (the user: no copy/tps bar by the ring). Skip it — the ProcessingRing IS
                // this phase; the real row appears the moment a token lands.
                const groupHasContent = group.some(
                  (m) =>
                    m.kind === 'assistant' &&
                    m.blocks.some((b) =>
                      b.type === 'text'
                        ? b.text.length > 0
                        : b.type === 'thinking'
                          ? b.thinking.length > 0
                          : true,
                    ),
                );
                if (!groupHasContent && streaming) return null;
                return (
                  <MessageRow
                    key={first.id}
                    kind="assistant"
                    actions={
                      <MessageActions
                        onCopy={() => copyText(groupPlainText(group))}
                        onRetry={() => retryFrom(first.id)}
                        /* No context chip. the user: "remove the context used one, just
                         keep the copy reload and toks/s". It was also the least
                         trustworthy number on the row — a whole-conversation
                         total rendered under every individual message. */
                        tokensPerSecond={streaming ? undefined : plausibleTps(tps)}
                      />
                    }
                  >
                    <AssistantGroup
                      group={group}
                      resultByCallId={resultByCallId}
                      runningToolCalls={runningToolCalls}
                      tps={streaming ? undefined : tps}
                    />
                  </MessageRow>
                );
              }

              if (item.kind === 'bash') {
                const message = item.message;
                return (
                  <ActivityRow
                    key={message.id}
                    icon={<IconTerminal size={14} />}
                    label={`! ${message.command}`}
                  >
                    <pre className="whitespace-pre-wrap pt-1 text-code text-text-secondary">
                      {message.output || '(no output)'}
                    </pre>
                  </ActivityRow>
                );
              }

              // Orphan tool result (rehydrated with no matching assistant block).
              const message = item.message;
              return (
                <ActivityRow
                  key={message.id}
                  icon={<IconTerminal size={14} />}
                  label={message.toolName}
                >
                  <pre className="whitespace-pre-wrap pt-1 text-code text-text-secondary">
                    {message.text || '(no output)'}
                  </pre>
                </ActivityRow>
              );
            })();
            if (cards === undefined) return node;
            return (
              <Fragment key={`anchored-${threadItemId(item)}`}>
                {node}
                {renderPresented(cards)}
              </Fragment>
            );
          })}

          {/* The corp run's live model output, as the assistant's answer:
              rendered AFTER the user's prompt bubble, inside the scroll flow, so it
              reads as Pi replying — never a takeover pane. A pinned subagent streams
              its feed; a promoted-but-unpinned run shows the CEO's "Waiting for N…"
              indicator (clickable → the situation-room canvas); pre-promotion streams
              the solo CEO/root. The subagent NAVIGATOR + checklist live in the
              situation-room canvas tab, which opens when the model builds a team. */}
          {/*
           * NO ROLE'S CHAT RENDERS HERE. EVER. the user, after three attempts at
           * this: "the embedded ceo-manager chat (not just the message bubble
           * the entire ceo-manager chat is shown there) just needs to be
           * removed. just remove that, not a complicated idea."
           *
           * A pinned role used to STREAM INTO THIS THREAD, which is how the
           * CEO-manager conversation ended up beneath the user's own messages —
           * they scroll to the bottom of their chat and find the manager saying
           * it is done. Every previous fix trimmed one route in and left this
           * one, because it only fires while something is pinned.
           *
           * A role is read in ITS OWN chat, opened from the sidebar or the
           * situation room — which is exactly what the user asked for the first
           * time: "ceo-manager is shown when clicked on the manager subchat
           * just as manager-subagent chat is shown when any subagent is
           * clicked on." This thread stays the user's conversation with Bobble
           * and nothing else.
           */}
          {corpTaskId !== null && corpView.kind === 'waiting' && corpSituation !== null ? /*
           * NOTHING. the user: "this forming a plan bar just needs to go in it's
           * entirety aswell."
           *
           * The inline corp turn lived here — a status bar reading "Forming a
           * plan" / "Waiting for N of M tasks", with the team listed under it.
           * It is a third place to read the same state: the sidebar already
           * shows every role with its own status, and the situation room shows
           * the team and the plan. Three views of one thing is what made this
           * confusing, and this was the one nobody asked for — it sat at the
           * bottom of the user's OWN conversation, which is where they look
           * for their answer, not for machinery.
           */
          null : corpTaskId !== null && corpView.kind === 'starting' ? (
            // Bridge the moment between submit and the first agent appearing so the
            // chat is never blank — the model is spinning up, not gone.
            <div className="pd-corpchat-starting" data-testid="corp-chat-starting">
              <Spinner size={13} />
              <span>Getting started…</span>
            </div>
          ) : null}

          {/* The ONE live status indicator (the user blind-test #1): a single
                thread-rendered element that reads "Thinking" while the model
                reasons and "Working" while it acts, with the harness stage folded
                in subtly. No duplicate label, no footer status, no stray spinner. */}
          <ThreadStatusIndicator />

          {/* Messages the user sent while this turn was still in-flight — held
              and shown as dimmed pending bubbles BELOW the live reply, so they
              read as "these send next" rather than reordering ahead of the reply
              (the message-ordering fix). They convert to real bubbles as the
              queue drains, one turn at a time. */}
          {queuedSends.map((q, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: queued sends have no stable id; FIFO order is the identity
            <MessageRow key={`queued-${i}`} kind="user" data-testid="queued-message">
              <div className="flex flex-col gap-2 opacity-55">
                {q.images.length > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    {q.images.map((src) => (
                      // biome-ignore lint/a11y/useAltText: user attachment thumbnail
                      <img key={src} src={src} className="max-h-32 rounded-md" />
                    ))}
                  </div>
                ) : null}
                {q.text.length > 0 ? <span className="whitespace-pre-wrap">{q.text}</span> : null}
              </div>
            </MessageRow>
          ))}
          {/*
           * Anything whose anchor is NOT in this thread — a card presented
           * before the first message, or one whose turn was edited away. The
           * foot is where these used to live, and it is still the right place
           * for an artefact with nowhere else to be.
           */}
          {orphanPresented.length > 0 ? renderPresented(orphanPresented) : null}
          {/* Breathing room so the last message/thought is never jammed against
              the composer — the user can scroll it up clear of the input bar. */}
          <div className="h-28 shrink-0" aria-hidden />
        </Thread>
      </ScrollArea>
      {away ? (
        <button
          type="button"
          className="pd-jump-latest pd-focusable"
          onClick={jumpToLatest}
          aria-label="Jump to latest"
          title="Jump to latest"
          data-testid="chat-jump-latest"
        >
          <IconChevronDown size={16} />
        </button>
      ) : null}
    </div>
  );
}
