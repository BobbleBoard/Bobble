/**
 * A stuck agent can STOP AND SAY WHY, and its manager finds out.
 *
 * The user, watching a manager spend 32 minutes on "waiting for other subagents to
 * finish" and then conclude the tool was broken: "give the manager a 'wait' tool
 * that will wait for a subagent to complete, or for a subagent to call its wait
 * tool with a reason, eg. needs help, something not working, please advise, etc.
 * will then alert the manager for example at its next tool round eg. <tool
 * result> + 'additional info, <subagent> is stopped: <message>'."
 *
 * THE MESH IS SYNCHRONOUS, which decides the shape of this. `AgentMesh.deliver`
 * runs a recipient's whole turn and returns its reply, so `talk_to` ALREADY
 * blocks until that agent is done — a manager "waiting for a subagent to
 * complete" is what every hand-off does. A `wait` that truly blocked would
 * deadlock, because the manager holds the stack and nothing else can move.
 *
 * So the missing half is the SUBAGENT's: today an agent that cannot proceed has
 * only one exit — reply — and a reply is indistinguishable from finished work.
 * That is how "the engineer keeps replying with nothing" became "the tool isn't
 * functioning properly for this engineer": an agent in trouble and an agent with
 * nothing to say produce the same thing.
 *
 * {@link RAISE_HAND_TOOL} gives it a second exit that is unmistakably not a
 * deliverable, and {@link handAlert} is how the manager hears about one raised
 * while it was busy elsewhere — appended to its next tool result, so no new turn
 * is needed.
 *
 * Pure: definitions + formatting + a small ledger. No I/O, no model.
 */

/** Stop, and tell your manager why. Available to every non-lead agent. */
export const RAISE_HAND_TOOL = 'raise_hand';

/** Stand by until the team comes back. The manager's side of the same channel. */
export const WAIT_TOOL = 'wait';

export const WAIT_TOOL_DEF = {
  name: WAIT_TOOL,
  description:
    'Stand by until somebody you delegated to finishes, or needs you. Handing work ' +
    'out does NOT wait for it — the people you brief start immediately and keep ' +
    'working while you carry on — so this is how you find out how it went.\n\n' +
    'Use it once you have delegated everything you mean to delegate this round. ' +
    'It returns as soon as the FIRST person comes back or raises a hand, not when ' +
    'everyone is done, so you hear about trouble early. Call it again to keep ' +
    'waiting for the rest.\n\n' +
    'Do NOT build the work yourself while your team is building it.',
  parameters: { type: 'object', properties: {}, required: [] },
} as const;

/**
 * THE MANAGER'S STANDING ORDER, the user verbatim.
 *
 * A manager with idle hands starts building, which is the failure the delegation
 * gates exist to stop — in the run that prompted this it spent 32 minutes
 * "waiting", decided its team was broken, and began writing the product itself.
 * Saying what standing by IS makes waiting a legitimate action rather than the
 * absence of one.
 */
export const MANAGER_STANDBY_INSTRUCTION =
  'Wait once you do the initial delegation round until there is substantial work in ' +
  "and it's ready to test. You shouldn't be doing anything but waiting or " +
  "advising/helping out when asked until everyone is done — that's when you test, or " +
  "do another round. When you've delegated everyone you want for the round, you're " +
  'either delegating more, sending messages to already delegated workers, or being on ' +
  `standby (\`${WAIT_TOOL}\`).`;

/** What a raised hand is FOR — the shape of the trouble, not its severity. */
export const HAND_REASONS = ['needs_help', 'not_working', 'please_advise', 'blocked'] as const;
export type HandReason = (typeof HAND_REASONS)[number];

/** One agent's raised hand, waiting to reach whoever should hear it. */
export interface RaisedHand {
  /** The agent that stopped. */
  readonly from: string;
  readonly reason: HandReason;
  /** What it was doing and what it needs, in its own words. */
  readonly message: string;
  /** What it already tried, so the manager does not send it back round the loop. */
  readonly tried?: string;
}

export const RAISE_HAND_TOOL_DEF = {
  name: RAISE_HAND_TOOL,
  description:
    'STOP and ask for help, without pretending you finished. Use this the moment you ' +
    'are stuck: a tool that will not work, a file you cannot find, a dependency that ' +
    'is missing, an instruction you cannot carry out, or anything you have retried ' +
    'and cannot get past. Your manager is told exactly what you say here.\n\n' +
    'This is NOT failure and NOT giving up early — it is the correct move when you ' +
    'are blocked, and it is far better than replying with a summary of what you could ' +
    'not do. A reply looks like finished work to whoever asked you; this does not. ' +
    'Do the work if you can do the work. Raise your hand the moment you cannot.',
  parameters: {
    type: 'object',
    properties: {
      reason: {
        type: 'string',
        enum: [...HAND_REASONS],
        description:
          'needs_help = you know what to do but cannot do it alone; not_working = a ' +
          'tool or command keeps failing; please_advise = the instruction is ' +
          'ambiguous or looks wrong; blocked = something outside your control stops you.',
      },
      message: {
        type: 'string',
        description:
          'What you were doing and what you need, plainly. Name the file, the command ' +
          'or the tool. "The browser tool returns no elements on main.html" beats "it ' +
          'is not working".',
      },
      tried: {
        type: 'string',
        description:
          'OPTIONAL but valuable: what you already attempted, so nobody sends you ' +
          'back round the same loop.',
      },
    },
    required: ['reason', 'message'],
  },
} as const;

/** Plain-language form of a reason, for the note a manager reads. */
export function reasonPhrase(reason: HandReason): string {
  switch (reason) {
    case 'needs_help':
      return 'needs help';
    case 'not_working':
      return 'something is not working';
    case 'please_advise':
      return 'wants advice';
    case 'blocked':
      return 'is blocked';
  }
}

/**
 * What the agent that raised its hand returns to whoever called it.
 *
 * Deliberately NOT shaped like a deliverable. The whole point is that a manager
 * reading this cannot mistake it for completed work, which a prose reply always
 * could be.
 */
export function raisedHandReply(hand: RaisedHand): string {
  const tried =
    hand.tried !== undefined && hand.tried.length > 0 ? `\nAlready tried: ${hand.tried}` : '';
  return (
    `STOPPED — ${hand.from} ${reasonPhrase(hand.reason)} and did NOT finish this work.\n` +
    `${hand.message}${tried}\n\n` +
    'Nothing was delivered. Answer them, change the instruction, or give the work to ' +
    'somebody else — do not record this as done.'
  );
}

/**
 * The note appended to a manager's NEXT tool result — the user's exact mechanism, so
 * a hand raised while the manager was busy elsewhere still reaches it without
 * needing a turn of its own.
 */
export function handAlert(hands: readonly RaisedHand[]): string {
  if (hands.length === 0) return '';
  const lines = hands.map(
    (h) =>
      `additional info, ${h.from} is stopped: ${h.message}` +
      (h.tried !== undefined && h.tried.length > 0 ? ` (already tried: ${h.tried})` : ''),
  );
  return `\n\n${lines.join('\n')}`;
}

/**
 * Append any pending alerts to a tool result. Returns the result UNCHANGED when
 * there is nothing waiting, so this can sit on every tool return without
 * decorating quiet ones.
 */
export function withHandAlerts(result: string, hands: readonly RaisedHand[]): string {
  return hands.length === 0 ? result : `${result}${handAlert(hands)}`;
}

/**
 * Pending raised hands, by the agent that should hear them.
 *
 * A ledger rather than a queue on the agent itself: a hand is raised during one
 * agent's turn and read during another's, and the two are not adjacent. Draining
 * is destructive by design — an alert repeated on every subsequent tool result
 * would train the manager to ignore it.
 */
export class HandLedger {
  private readonly byManager = new Map<string, RaisedHand[]>();

  /** Record a raised hand for `manager` to hear. */
  raise(manager: string, hand: RaisedHand): void {
    const list = this.byManager.get(manager) ?? [];
    list.push(hand);
    this.byManager.set(manager, list);
  }

  /** Take everything waiting for `manager`, clearing it. */
  drain(manager: string): RaisedHand[] {
    const list = this.byManager.get(manager);
    if (list === undefined || list.length === 0) return [];
    this.byManager.delete(manager);
    return list;
  }

  /** Look without clearing — for a status line, never for delivery. */
  peek(manager: string): readonly RaisedHand[] {
    return this.byManager.get(manager) ?? [];
  }

  /** Every agent with a hand still up (the run's own "who is stuck" view). */
  pendingManagers(): string[] {
    return [...this.byManager.entries()].filter(([, v]) => v.length > 0).map(([k]) => k);
  }
}

/** Park a subagent until the manager messages it again. */
export const PAUSE_TOOL = 'pause_subagent';

/**
 * STAND SOMEBODY DOWN — the manager's side of waiting.
 *
 * The user: "maybe have the manager get a stop subagent tool call, that will pause it
 * until the manager decides to message it again."
 *
 * The gap it fills: a manager could hand work out and wait for it, but had no way
 * to tell somebody to STOP. Its only options for an engineer heading the wrong way
 * were to let it finish anyway or to say nothing — and a 4B that is told nothing
 * keeps going. Pausing is also how a manager frees the machine: this box runs one
 * model, so four engineers "working" are four turns queued on one slot, and
 * standing down the two that are not on the critical path makes the other two
 * finish sooner.
 *
 * Deliberately NOT a kill. The session stays open and the agent keeps everything
 * it knows; it simply takes no further turn until the manager talks to it, at
 * which point it carries on with its context intact. That is what makes this safe
 * to use liberally — the cost of pausing somebody wrongly is one message.
 */
export const PAUSE_TOOL_DEF = {
  name: PAUSE_TOOL,
  description:
    'Tell somebody working for you to STOP for now. They stay exactly as they are — ' +
    'nothing is lost, they keep everything they have done and everything they know — ' +
    'and they simply take no further turn until you message them again, which picks ' +
    'them straight back up where they left off.\n\n' +
    'Use it when their work is no longer the thing that matters: they are heading the ' +
    'wrong way, what they are building is not needed yet, or you want the machine free ' +
    'for somebody closer to finished. Pausing two people so the other two finish ' +
    'sooner is a normal thing to do here.\n\n' +
    'This is not firing anybody and not throwing work away. If you are unsure, pause ' +
    'them — the cost of being wrong is one message to start them again.',
  parameters: {
    type: 'object',
    properties: {
      agent: { type: 'string', description: 'Who to stand down, e.g. engineer:2.' },
      why: {
        type: 'string',
        description:
          'One line they will read when you restart them, so they know why they stopped.',
      },
    },
    required: ['agent'],
  },
} as const;

/** What a paused agent is told, and what the manager gets back. */
export function pausedNote(agent: string, why?: string): string {
  const reason = (why ?? '').trim();
  return reason === ''
    ? `${agent} is standing by. It keeps everything it has done; message it to pick back up.`
    : `${agent} is standing by (${reason}). It keeps everything it has done; message it to pick back up.`;
}

/**
 * Who is currently stood down. A plain set rather than agent state: pausing is a
 * fact about the MESH's scheduling, not about the agent, and it has to survive the
 * agent being mid-anything.
 */
export class PauseLedger {
  private readonly paused = new Set<string>();

  pause(agent: string): void {
    this.paused.add(agent);
  }

  /** Messaging somebody is what un-pauses them — there is no separate resume. */
  resume(agent: string): void {
    this.paused.delete(agent);
  }

  isPaused(agent: string): boolean {
    return this.paused.has(agent);
  }

  list(): string[] {
    return [...this.paused].sort();
  }
}
