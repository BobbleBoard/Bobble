/**
 * Store-ready chat message shapes. The live event router and the session
 * rehydrator both emit this union, so UIs never care whether a message came
 * from a live stream or from history.
 */
import type { StopReason, Usage } from './rpc';

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | {
      type: 'toolCall';
      id: string;
      name: string;
      arguments: Record<string, unknown>;
      /**
       * Raw streamed argument JSON accumulated from toolcall_delta events.
       * Present only while/if args streamed; `arguments` holds the parsed
       * form once toolcall_end (or rehydration) provides it.
       */
      argsText?: string;
    };

export interface UserMsg {
  kind: 'user';
  id: string;
  text: string;
  /** Attached images as data URIs (`data:<mimeType>;base64,<data>`) — the
   * same representation the composer pushes for live user messages, so
   * rehydrated and live rows render identically. */
  images?: string[];
  /**
   * What pi was actually sent, when that differs from the visible `text`.
   *
   * The composer folds text attachments into the model's copy as fenced blocks
   * and echoes only what was typed. Without this the LIVE bubble knew nothing
   * about its own files — no cards under the message, and editing it silently
   * dropped them — while the same message reloaded from disk (where pi's copy
   * IS the message) rendered them correctly. One field makes the two identical.
   */
  agentText?: string;
  timestamp: number;
}

export interface AssistantMsg {
  kind: 'assistant';
  id: string;
  blocks: ContentBlock[];
  model?: string;
  provider?: string;
  stopReason?: StopReason;
  errorMessage?: string;
  isStreaming?: boolean;
  usage?: Usage;
  timestamp: number;
}

export interface ToolResultMsg {
  kind: 'toolResult';
  /** Router rows embed the owning assistant id (`tr-<assistantId>-<callId>`)
   * so a provider-reused toolCallId in a later turn/run never collides with
   * an earlier row. Sinks must upsert by `id`, not by `toolCallId`. */
  id: string;
  toolCallId: string;
  /** The assistant message this result belongs to (router rows only; absent
   * on rehydrated rows and orphan results arriving after turn_end). */
  assistantId?: string;
  toolName: string;
  text: string;
  isError: boolean;
  timestamp: number;
}

export interface BashExecMsg {
  kind: 'bashExec';
  id: string;
  command: string;
  output: string;
  exitCode: number;
  timestamp: number;
}

/**
 * A harness warning, in the transcript rather than in a toast.
 *
 * The harness raises real, actionable warnings — a model too small for the work
 * it just reached for, a verify pass that failed, the loop guard steering a
 * stuck turn — and every one of them was DROPPED at the event router, which
 * passed only `error` through. Even routed, a toast is the wrong shape: these
 * describe a specific turn and should stay beside it, not slide away after four
 * seconds.
 *
 * Warnings only. `info` is machine echo — the app fires `/harness set-mode`,
 * `effort`, `workspace` and `preset` programmatically on every settings change,
 * chat open and gen action, so routing it would inject "effort → high" rows into
 * ordinary conversations.
 *
 * IN MEMORY ONLY. `setMessages` on rehydrate replaces the thread from the
 * session file, which does not carry these — a reopened chat has no notices.
 */
export interface NoticeMsg {
  kind: 'notice';
  id: string;
  level: 'warning';
  text: string;
  timestamp: number;
}

export type ChatMsg = UserMsg | AssistantMsg | ToolResultMsg | BashExecMsg | NoticeMsg;
