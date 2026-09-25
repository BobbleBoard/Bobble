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
  IconTerminal,
  MessageActions,
  MessageRow,
  PresentCard,
  ScrollArea,
  Spinner,
  Thread,
  writeClipboardText,
} from '@pi-desktop/ui';
import { Fragment, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { IconWarning } from '../settings/icons';
import { useCorpStore } from '../state/corp-store';
import { useLlmStore } from '../state/llm-store';
import { forkAndReprompt, switchBranch } from '../state/pi-connect';
import { usePiStore } from '../state/pi-slice';
import {
  isInlinePresented,
  type PresentedRecord,
  presentedFor,
  showPresented,
  UNSAVED_CHAT,
  usePresentStore,
} from '../state/present-store';
import { useTurnPrefilling } from '../state/running-chats';
import { AssistantGroup } from './AssistantGroup';
import { AttachedFileCard } from './AttachedFileCard';
import { type AttachedFile, splitAttachedFiles } from './attached-files';
import { reportOpen } from './canvas/open-outcome';
import { buildAgentMessage } from './composer/agent-message';
import { useDropStore } from './composer/drop-store';
import { corpChatView } from './corp/corp-thread-view';
import { HarnessChecklistPanel, ThreadStatusIndicator } from './HarnessStatus';
import { HistoryPole } from './HistoryPole';
import { effectiveToolName } from './long-job';
import { MessageErrorBoundary } from './MessageErrorBoundary';
import { PresentedInline } from './PresentedInline';
import { awaitingReplyAfterLatestTurn, sentAttachmentsPrefilling } from './sent-prefill';
import { ThreadMedia } from './ThreadMedia';
import { followToLatest, useThreadFollow } from './thread-follow';
import { mediaItemForPath } from './thread-media';
import { useThreadSlots } from './thread-slots';
import { attributeRecords, type CallResultFacts } from './turn-cards';
import { BlindImageNote, UserImage } from './UserImage';

/** Concatenated visible text of an assistant response group (for copy). */
function groupPlainText(group: AssistantMsg[]): string {
  return (
    group
      .flatMap((m) => m.blocks)
      .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
      // Only what IS text: the reply that failed to draw may have failed on a
      // block whose text is not a string, and "[object Object]" is not it.
      .map((b) => (typeof b.text === 'string' ? b.text : ''))
      .join('')
  );
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
  const chatKey = usePiStore((s) => s.session?.sessionFile ?? UNSAVED_CHAT);
  const presented = usePresentStore((st) => presentedFor(st, chatKey));

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

  /*
   * WHICH CALL HANDED EACH CARD OVER. A presented card belongs with the call
   * that made it — the chart call, the drawing, the `present` — and the turn
   * places it the way it places the media it generated: filed in the chain
   * while the work goes on, beneath it once it is an answer (AssistantGroup,
   * turn-cards.ts). They used to render after the whole reply, which during a
   * turn is the foot of the conversation — the user (2026-09-24): "generations/
   * inline cards of any kind always seem to get pinned to the bottom of the
   * chat for quite some time, including during working/iteration".
   *
   * The charts still being MADE went with them: a pending chart is a
   * generating card like any other, and stands beneath the chain making it.
   */
  const attributeTurn = (
    group: readonly AssistantMsg[],
    records: readonly PresentedRecord[],
  ): ReturnType<typeof attributeRecords<PresentedRecord>> => {
    const calls: CallResultFacts[] = [];
    for (const m of group) {
      for (const b of m.blocks) {
        if (b.type !== 'toolCall') continue;
        const result = resultByCallId.get(`${m.id}:${b.id}`) ?? resultByCallId.get(b.id);
        calls.push({
          id: b.id,
          tool: effectiveToolName(b.name, b.arguments),
          text: result?.text,
          isError: result?.isError ?? false,
        });
      }
    }
    return attributeRecords(calls, records);
  };

  /* One card, wherever it is drawn — after its turn when no call in the turn
     accounts for it, or at the foot when its turn is not in this thread. */
  const renderPresented = (records: readonly PresentedRecord[]): ReactNode => (
    <div className="flex flex-col gap-2 pt-2" data-testid="presented">
      {records.map((record) => renderRecord(record))}
    </div>
  );
  /* A chart, or a small SVG, IS shown here — the card is the thing, not a
   * row pointing at the canvas (PresentedInline). So is a picture, a clip, a
   * sound or a model the model presented: the user (2026-09-24) wants what is
   * handed over "shown in the full big card" — the media card with its
   * controls — while the same thing un-presented sits small in the work
   * (turn-cards.ts). */
  const renderRecord = (item: PresentedRecord): ReactNode => {
    const media = isInlinePresented(item) ? null : mediaItemForPath(item.path);
    if (media !== null) return <ThreadMedia key={item.path} items={[media]} />;
    return isInlinePresented(item) ? (
      <PresentedInline key={item.path} item={item} />
    ) : (
      <PresentCard
        key={item.path}
        item={item}
        /* Body AND the blue Open → the canvas (the user: "by default it opens
         * in the canvas or it should") — opened onto the screen, not just
         * focused behind a closed rail (showPresented). The dropdown is "Open
         * with": every application, the OS default among them. Each hand-off
         * reads main's answer and says why when it could not (open-outcome). */
        onActivate={() => void showPresented(canvasController, item)}
        onOpen={() => void showPresented(canvasController, item)}
        onOpenWith={(_it, appId) => {
          const app = [item.defaultApp, ...(item.openApps ?? [])].find((a) => a?.id === appId);
          void reportOpen(
            () => window.piDesktop.invoke('canvas:open-with', { path: item.path, appId }),
            { verb: 'open', path: item.path, ...(app !== undefined ? { appName: app.name } : {}) },
          );
        }}
        onReveal={() => {
          void reportOpen(() => window.piDesktop.invoke('canvas:reveal', { path: item.path }), {
            verb: 'reveal',
            path: item.path,
          });
        }}
      />
    );
  };

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
    // Saving an edit sends it: follow the new reply like any other send.
    followToLatest();
    void forkAndReprompt(id, text, body === text ? undefined : body);
  };

  const scrollRef = useRef<HTMLDivElement>(null);
  // Autoscroll "stick": true only while the user is parked at the bottom. It is
  // released the instant the user scrolls UP (free-scroll during generation,
  // round-8) and re-armed only when they return to the bottom — so a burst of
  // streaming re-renders can never yank the view back down while they read above.
  const pinnedRef = useRef(true);
  /*
   * WHICH WAY THE USER LAST MEANT TO GO. the user (2026-09-12): "the slightest bit
   * of user scrolling up manually, I need to be freed from the auto scroll …
   * if they tap the bottom at all, then activate the auto scroll, but if they
   * ever go up, even the tiniest bit (manually) the auto scroll doesn't snap
   * you down."
   *
   * The wheel handler below did release on the first upward tick — and the
   * scroll event that followed it re-armed the stick, because "within 16px of
   * the bottom" was the re-arm test and a tiny scroll-up leaves you within
   * 16px of the bottom. The next streamed line snapped the view down. So the
   * re-arm now needs BOTH the bottom itself (2px, not 16) and a downward
   * gesture since the last upward one: a scroll-up of any size stays released
   * until the user comes back down to the bottom.
   */
  const intentRef = useRef<'up' | 'down'>('down');
  /*
   * WHERE WE LAST PUT THE THREAD OURSELVES. the user (2026-09-20), after a chat
   * with the media tools: "new stuff seems to go above old stuff in the chat
   * rather than going below the old stuff" — the thread had stopped following,
   * so every later turn landed under the composer, out of sight, while the
   * view stayed on the older turns.
   *
   * MEASURED (chat-order-probe DIAG): the follow below set scrollTop to the
   * foot (1138); by the time the browser dispatched that scroll's event — a
   * frame later — the chart card had grown the thread by 50px, so the event
   * read as "50px above the foot", the stick was released as if the user had
   * scrolled up, and nothing re-armed it. Our own scroll must never count as
   * the user leaving: a scroll event that finds the view exactly where we put
   * it is ours, whatever the gap has become since; only a position we did not
   * set — a scrollbar drag, a wheel — is theirs.
   */
  const placedRef = useRef(-1);
  const follow = useCallback(() => {
    const el = scrollRef.current;
    if (el === null) return;
    el.scrollTop = el.scrollHeight;
    // What the browser clamps the request to — the position the event reports.
    placedRef.current = el.scrollTop;
  }, []);

  const onScroll = () => {
    const el = scrollRef.current;
    if (el === null) return;
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (Math.abs(el.scrollTop - placedRef.current) <= 1) {
      // Our own follow arriving. Content grew under it? Follow again.
      if (pinnedRef.current && gap > 2) follow();
      return;
    }
    if (gap > 2) pinnedRef.current = false;
    else if (intentRef.current === 'down') pinnedRef.current = true;
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
      intentRef.current = 'up';
    };
    const meanDown = () => {
      intentRef.current = 'down';
    };
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) releaseUp();
      else if (e.deltaY > 0) meanDown();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowUp' || e.key === 'PageUp' || e.key === 'Home') releaseUp();
      else if (e.key === 'ArrowDown' || e.key === 'PageDown' || e.key === 'End' || e.key === ' ') {
        meanDown();
      }
    };
    let lastY = 0;
    const onTouchStart = (e: TouchEvent) => {
      lastY = e.touches[0]?.clientY ?? 0;
    };
    const onTouchMove = (e: TouchEvent) => {
      const y = e.touches[0]?.clientY ?? 0;
      if (y > lastY + 1)
        releaseUp(); // finger drags down → content moves up
      else if (y < lastY - 1) meanDown();
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
   * NO WAY-BACK-DOWN BUTTON. There was one — a chevron that appeared when the
   * view was 120px or more above the bottom — and the user had it removed
   * (2026-09-13: "remove … the go to bottom button"). The stick re-arms the
   * way it always did: scroll to the bottom with a downward intent and the
   * thread follows again (see the handlers above). Dropping it also drops the
   * per-render layout read that used to feed it.
   */

  // Keep the newest content in view ONLY while pinned (never fights a scroll-up).
  useEffect(() => {
    if (pinnedRef.current) follow();
  });
  /*
   * …AND A SEND RE-PINS IT. the user (2026-09-24): "pressing enter on a chat should
   * take you to the bottom". The same re-arm scrolling back down to the foot
   * gives — pinned, meaning down — so the reply is followed from here, and the
   * next wheel tick up releases it exactly as before (see thread-follow.ts).
   * Deliberately not on every new message: a queued message draining, or a
   * reply arriving, must never pull a reader back down from what they are
   * reading. Only the reader's own send does.
   */
  const followRequests = useThreadFollow((s) => s.requests);
  useEffect(() => {
    if (followRequests === 0) return;
    pinnedRef.current = true;
    intentRef.current = 'down';
    follow();
  }, [followRequests, follow]);
  /*
   * …and when the content grows WITHOUT a render: a card revealing, a picture
   * decoding, a chart building itself. Those used to leave the foot a card's
   * height out of view until the next token happened to re-render the thread.
   */
  useEffect(() => {
    const el = scrollRef.current;
    const content = el?.firstElementChild;
    if (el === null || !(content instanceof HTMLElement)) return;
    const ro = new ResizeObserver(() => {
      if (pinnedRef.current) follow();
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, [follow]);

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

  /*
   * THE ATTACHMENT SPINNER SURVIVES SEND.
   *
   * the user: "they stop loading maybe even after sent, the loading spinner can
   * still be on them, it disapears when they are prefilled." The chips leave the
   * composer with the message and used to arrive here with no prefill state at
   * all, so the spinner vanished at the exact moment the wait became real.
   *
   * The phase is NOT re-derived: `useTurnPrefilling` reads the same
   * `RunningChat.status === 'prefilling'` the thread's processing ring is built
   * from, so the ring and these chips can never disagree. See sent-prefill.ts
   * for the rest of the rule, and for why an unanswered-turn check is what stops
   * a reopened chat from spinning forever about a question answered days ago.
   */
  const turnPrefilling = useTurnPrefilling();
  const latestUserId = (() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i];
      if (m?.kind === 'user') return m.id;
    }
    return null;
  })();
  const awaitingReply = awaitingReplyAfterLatestTurn(messages);

  /* Cards a feature hangs under a turn (./thread-slots.ts) — none until one
     registers, and then the row renders exactly as below plus the slot. */
  const threadSlotDefs = useThreadSlots();
  const items = toRenderItems(messages, claimed);
  /*
   * Presented artefacts, bucketed by the row they were handed over after. A
   * record whose anchor is not in this thread (presented before the first
   * message, or its turn edited away) has nowhere to sit and falls to the foot.
   */
  /*
   * EVERY message of a row claims the row, not only its last one. the user
   * (2026-09-12): "file cards pin themselves to the bottom of a chat rather
   * than the bottom of the message they were called in." The anchor is the
   * LAST message at the moment of the hand-over — mid-turn that is the
   * assistant message (or tool result) the `present` call sits in, and the
   * turn goes on after it. The row was keyed by its last message only, so any
   * card presented before the turn's final message matched nothing, fell to
   * the foot, and sank under every later user message. A row now owns every
   * message id it draws — each assistant message in the group and the tool
   * results claimed by them — and a card lands under the row that owns its
   * anchor, whatever the turn did afterwards.
   */
  const rowOfMessage = new Map<string, string>();
  for (const item of items) {
    const key = threadItemId(item);
    if (item.kind === 'assistant') {
      for (const m of item.group) rowOfMessage.set(m.id, key);
    } else {
      rowOfMessage.set(item.message.id, key);
    }
  }
  for (const m of messages) {
    if (m.kind !== 'toolResult' || rowOfMessage.has(m.id)) continue;
    const owner = m.assistantId !== undefined ? rowOfMessage.get(m.assistantId) : undefined;
    if (owner !== undefined) rowOfMessage.set(m.id, owner);
  }
  const presentedByAnchor = new Map<string, PresentedRecord[]>();
  const orphanPresented: PresentedRecord[] = [];
  for (const record of presented) {
    const row =
      record.afterMessageId === null ? undefined : rowOfMessage.get(record.afterMessageId);
    if (row === undefined) {
      orphanPresented.push(record);
      continue;
    }
    const bucket = presentedByAnchor.get(row);
    if (bucket === undefined) presentedByAnchor.set(row, [record]);
    else {
      // The same file presented twice within one row (two iterations of one
      // turn) is one card, the later one; across rows they are two cards.
      const dup = bucket.findIndex((r) => r.path === record.path);
      if (dup === -1) bucket.push(record);
      else bucket[dup] = record;
    }
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

          {items.map((item, itemIndex) => {
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
            const anchored = presentedByAnchor.get(threadItemId(item));
            const turn =
              item.kind === 'assistant' && anchored !== undefined
                ? attributeTurn(item.group, anchored)
                : null;
            // Only what no call in the turn accounts for still hangs after it.
            const cards = turn !== null ? turn.loose : anchored;
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
                    {/*
                      WHAT YOU BROUGHT IS NOT WHAT YOU SAID.
                      A pasted block, a dropped file and a pinned image sit
                      BESIDE the message, not inside its bubble. the user:
                      "pastes/images/files … should not be contained in the grey
                      box." They are already boxes in their own right — a card
                      inside a bubble is two containers saying the same thing,
                      and it made a one-line question look like a wall. An `@`
                      mention is the exception and always was: it is part of the
                      sentence, so it stays in the sentence.
                    */}
                    {message.images !== undefined && message.images.length > 0 ? (
                      <div className="flex flex-col items-end gap-2">
                        <div className="flex flex-wrap justify-end gap-2">
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
                      </div>
                    ) : null}
                    {attached.files.length > 0 ? (
                      <div
                        className="flex flex-wrap justify-end gap-2"
                        data-testid="user-attachments"
                      >
                        {(() => {
                          const stillReading = sentAttachmentsPrefilling({
                            files: attached.files,
                            isLatestTurn: message.id === latestUserId,
                            awaitingReply,
                            turnPrefilling,
                          });
                          return attached.files.map((f) => (
                            <AttachedFileCard
                              key={f.id}
                              name={f.name}
                              text={f.text}
                              prefilling={stillReading.has(f.id)}
                            />
                          ));
                        })()}
                      </div>
                    ) : null}
                    {/*
                      An attachment sent with nothing typed still needs its copy
                      and edit controls, so the row is rendered either way — but
                      with no bubble drawn around an empty string.
                    */}
                    <MessageRow
                      kind={attached.text.length > 0 ? 'user' : 'assistant'}
                      actions={
                        <MessageActions
                          onCopy={() => copyText(message.text)}
                          onEdit={() => beginEdit(message)}
                        />
                      }
                      className={attached.text.length > 0 ? undefined : 'items-end'}
                    >
                      {attached.text.length > 0 ? <ClampedText text={attached.text} /> : null}
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
                    <MessageErrorBoundary fallbackText={groupPlainText(group)}>
                      <AssistantGroup
                        group={group}
                        resultByCallId={resultByCallId}
                        runningToolCalls={runningToolCalls}
                        tps={streaming ? undefined : tps}
                        {...(turn !== null && turn.byCall.size > 0
                          ? { recordsByCall: turn.byCall }
                          : {})}
                        renderRecord={renderRecord}
                      />
                    </MessageErrorBoundary>
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
            const hasPresented = cards !== undefined && cards.length > 0;
            // Every registered feature slot, told which row it is under.
            const featureSlots =
              threadSlotDefs.length === 0
                ? null
                : threadSlotDefs.map((slot) => (
                    <slot.Component
                      key={`slot-${slot.id}`}
                      kind={item.kind}
                      anchorId={threadItemId(item)}
                      messageIds={
                        item.kind === 'assistant' ? item.group.map((m) => m.id) : [item.message.id]
                      }
                      isLast={itemIndex === items.length - 1}
                    />
                  ));
            if (!hasPresented && featureSlots === null) return node;
            return (
              <Fragment key={`anchored-${threadItemId(item)}`}>
                {node}
                {hasPresented ? renderPresented(cards) : null}
                {featureSlots}
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
              the composer. the user (2026-09-12): "reduce buffer space between
              stream and input bar" — it was 112px on top of the message's own
              action row, ~170px of nothing under a streaming reply. */}
          <div className="h-6 shrink-0" aria-hidden data-testid="thread-tail-space" />
        </Thread>
      </ScrollArea>
    </div>
  );
}
