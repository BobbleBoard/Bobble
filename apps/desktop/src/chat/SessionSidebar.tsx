import {
  Checkbox,
  CollapsibleSearch,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  FolderGlyph,
  Glyph,
  IconChat,
  IconChevronDown,
  IconFolderPlus,
  IconMore,
  IconPencil,
  IconPin,
  IconPlus,
  IconSettings,
  IconShare,
  IconTrash,
  Kbd,
  Sidebar,
  SidebarRow,
  SidebarScroll,
  SidebarSection,
  Spinner,
  writeClipboardText,
} from '@pi-desktop/ui';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SessionSummary } from '../../electron/ipc-contract';
import type { ChatProject } from '../../electron/settings/settings-contract';
import { useRouteViewsVersion } from '../route-views';
import { IconMoon, IconSun } from '../settings/icons';
import type { SettingsSection } from '../settings/SettingsView';
import { navigate } from '../state/app-nav-store';
import { deleteChatNow } from '../state/chat-delete';
import {
  assignChat,
  createProject,
  deleteProject,
  displayTitle,
  groupChats,
  renameChat,
  renameProject,
  setProjectCwd,
  togglePin,
  useChatOrg,
} from '../state/chat-org';
import { useChildAgentStore, useChildrenByParent } from '../state/child-agent-store';
import { useCorpStore } from '../state/corp-store';
import { isChatDeleted, useDeletedChats } from '../state/deleted-chats';
import { useModalityStore } from '../state/modality-store';
import { listSessions, newSession, restartPi, switchSession } from '../state/pi-connect';
import { usePiStore } from '../state/pi-slice';
import { useProjectStore } from '../state/project-store';
import { useSettingsStore } from '../state/settings-store';
import { publishSessionList } from '../state/visible-projects';
import { useThemeStore } from '../store/theme';
import { formatModuleSize } from '../tripo/module-state';
import { BobbleMark } from './BobbleMark';
import { BG_RUN_IDLE, type BgRunWatch, watchBgRun } from './bg-run-watch';
import { PROFILE_MENU_ACTIONS } from './profile-menu';
import {
  type DeleteChatOption,
  runDeleteOptions,
  type ThreadMenuContext,
  threadMenuEntriesFor,
  useDeleteChatOptions,
  useThreadMenuEntries,
} from './thread-menu-entries';
import { type WorkspaceNavContext, workspaceNavRows } from './workspace-nav';

/**
 * How long typing has to settle before main searches session BODIES.
 *
 * Title filtering is in-memory and instant; this one walks every session file
 * on a synchronous main-process handler, so it must not run per keystroke.
 */
const SEARCH_DEBOUNCE_MS = 220;

/**
 * How long a background run has to have taken before finishing is worth an OS
 * notification.
 *
 * A reply that took two seconds is not something to interrupt someone for —
 * they either saw it or will in a moment. The floor is what separates "your
 * long job is done" from a notification per message.
 */
const NOTIFY_MIN_RUN_MS = 20_000;

/**
 * Bottom-left profile control (round-12 #4). ONE compact button — the avatar
 * (rail) or the full "Bobble · Local" row (expanded) — that opens a DROPUP
 * (side="top") holding Settings and Toggle theme.
 *
 * It used to end in a User / Power-user toggle. the user: "the power user/user toggle
 * has been completely broken, however I think it's a good idea for us to remove
 * that now that I think about it, so let's remove that toggle anyways." Removing
 * the control meant choosing a mode rather than leaving everyone on the 'user'
 * default, which gates the Model hub out of the composer entirely — see
 * footer-models.ts / TierPickerMenu. Everything now behaves as power did. Rendered in both sidebar shapes so both
 * share one menu; the `open-settings` / `toggle-mode` testids move onto the menu
 * rows (probes open the menu first, then click them).
 */
function SidebarProfileMenu({
  variant,
  onOpenSettings,
}: {
  variant: 'full' | 'rail';
  onOpenSettings: (section: SettingsSection) => void;
}) {
  const mode = useThemeStore((s) => s.mode);
  const setTheme = useSettingsStore((s) => s.setTheme);

  const trigger =
    variant === 'rail' ? (
      <button
        type="button"
        className="pd-rail-btn pd-focusable"
        aria-label="Account, settings and theme"
        title="Account, settings and theme"
        data-testid="profile-button"
      >
        {/* Same --pd-icon-size centering box as the rail icons so the avatar
            sits on the identical x through the collapse (round-14 #7). */}
        <span className="pd-rail-btn-icon">
          <span className="pd-sidebar-avatar">B</span>
        </span>
      </button>
    ) : (
      /*
       * the user: "the hover highlight needs to be full width, same margin on the
       * right as left, remove the down arrow, add an embedded settings button
       * that takes you straight to settings one click, this highlights
       * individually, just a gear on the right side of the button, clicking the
       * rest still does the dropup".
       *
       * So the hover target is the ROW (inset equally on both sides), the gear is
       * a sibling with its own hover rather than a nested button — a button
       * inside a button is invalid HTML and the inner click would bubble into
       * the dropup, which is exactly the bug that shape produces.
       */
      <span className="pd-sidebar-footer-slot">
        <button
          type="button"
          data-testid="profile-button"
          aria-label="Account and theme"
          className="pd-sidebar-footer-main pd-focusable"
        >
          <span className="pd-sidebar-avatar">B</span>
          <span className="pd-sidebar-footer-name">
            Bobble<span className="pd-sidebar-footer-plan"> · Local</span>
          </span>
        </button>
      </span>
    );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="start"
        sideOffset={6}
        className="min-w-[240px]"
        data-testid="profile-menu"
      >
        {PROFILE_MENU_ACTIONS.map((action) =>
          action.id === 'settings' ? (
            <DropdownMenuItem
              key={action.id}
              data-testid={action.testid}
              icon={<IconSettings size={16} />}
              onSelect={() => onOpenSettings('personalization')}
            >
              {action.label}
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem
              key={action.id}
              data-testid={action.testid}
              icon={mode === 'dark' ? <IconMoon size={16} /> : <IconSun size={16} />}
              hint={mode === 'dark' ? 'Dark' : 'Light'}
              // Keep the menu open on flip so the change is visible in place.
              onSelect={(e) => {
                e.preventDefault();
                void setTheme({ mode: mode === 'dark' ? 'light' : 'dark' });
              }}
            >
              {action.label}
            </DropdownMenuItem>
          ),
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * How long the sidebar's slide actually lasts here, in ms.
 *
 * Read from the live `--pd-duration-slow` token rather than hardcoded, because
 * the flavors disagree (250ms / 300ms) and the reduced-motion theme sets it to
 * 0.01ms. A hardcoded hold would keep the panel mounted well past the end of its
 * movement in the first case, and in the second it would sit there holding a
 * slide that the theme has asked not to happen at all.
 */
function slideMs(): number {
  if (typeof window === 'undefined') return 300;
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue('--pd-duration-slow')
    .trim();
  const ms = raw.endsWith('ms')
    ? Number.parseFloat(raw)
    : raw.endsWith('s')
      ? Number.parseFloat(raw) * 1000
      : Number.NaN;
  return Number.isFinite(ms) ? ms : 300;
}

/** How long a project's chats take to slide open or shut — the folder's own morph. */
const PROJECT_SLIDE_MS = 240;

/**
 * A PROJECT'S CHATS SLIDE, they do not pop. the user (2026-09-23): "'projects'
 * opening/closing animation needs to be cleaner and slide up and down the
 * chats in the project." The list was mounted and unmounted in one frame
 * while only the folder glyph animated. Now the rows stay mounted for the
 * length of the slide and the box eases its height between nothing and its
 * content (grid-template-rows 0fr ↔ 1fr — no measuring), in step with the
 * folder's 240 ms fold.
 */
function ProjectChats({
  open,
  projectId,
  children,
}: {
  open: boolean;
  projectId: string;
  children: ReactNode;
}) {
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(open);
  useEffect(() => {
    if (open) {
      setMounted(true);
      // One frame at 0fr first, so the opening has somewhere to slide from.
      const raf = requestAnimationFrame(() => setShown(true));
      return () => cancelAnimationFrame(raf);
    }
    setShown(false);
    const t = window.setTimeout(() => setMounted(false), PROJECT_SLIDE_MS + 40);
    return () => window.clearTimeout(t);
  }, [open]);
  if (!mounted) return null;
  return (
    <div className="pd-project-chats-slide" data-open={shown ? 'true' : 'false'}>
      <div className="pd-project-chats-clip">
        <div className="pd-project-chats" data-testid={`project-chats-${projectId}`}>
          {children}
        </div>
      </div>
    </div>
  );
}

/** A 40×40 icon-only button for the collapsed rail (tooltip = its label). */
function _RailButton({
  label,
  icon,
  onClick,
  testid,
}: {
  label: string;
  icon: ReactNode;
  onClick: () => void;
  testid?: string;
}) {
  return (
    <button
      type="button"
      className="pd-rail-btn pd-focusable"
      aria-label={label}
      title={label}
      data-testid={testid}
      onClick={onClick}
    >
      {/* Round-14 #7: the glyph rides in the same --pd-icon-size centering box as
          an expanded row's icon (.pd-sidebar-row-icon), so its x is identical by
          construction in both flavors — no collapse "snap". */}
      <span className="pd-rail-btn-icon">{icon}</span>
    </button>
  );
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 60) return 'now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  return `${Math.floor(secs / 86400)}d`;
}

/**
 * The colour that goes with a child row's state word. Derived from the WORD so
 * this and the situation room cannot drift apart — one vocabulary, two surfaces.
 * `undefined` means no dot: working and anything unrecognised stay plain, since
 * a running row already has a spinner.
 */
function statusTone(label: string): 'done' | 'error' | 'paused' | 'waiting' | undefined {
  const w = label.trim().toLowerCase();
  if (w.startsWith('done') || w.startsWith('finish')) return 'done';
  if (w.startsWith('error') || w.startsWith('fail') || w.startsWith('block')) return 'error';
  if (w.startsWith('paus') || w.startsWith('stopp') || w.startsWith('stepped')) return 'paused';
  if (w.startsWith('wait') || w.startsWith('queue') || w.startsWith('idle')) return 'waiting';
  return undefined;
}

/*
 * The rail's own drawings (a cube, a pencil over a line) lived here until
 * 2026-09-20; the user handed over one set for the whole app — packages/ui
 * glyph.tsx — and these rows take theirs from it like every other surface.
 */
export function SessionSidebar({
  open,
  onTruncated,
  onOpenSettings,
  onOpenConnectors,
  onOpenScheduled,
  onEnterChat,
}: {
  open: boolean;
  onTruncated: () => void;
  onOpenSettings: (section: SettingsSection) => void;
  /** Open the Codex-style connectors gallery (its own top-level view). */
  onOpenConnectors: () => void;
  /** Open the scheduled-tasks view. */
  onOpenScheduled: () => void;
  /**
   * "The user is going to a conversation now." Fired for every way OUT of a
   * content route and INTO a chat: New chat, a chat row, a project's new chat,
   * a subagent row.
   *
   * BUG THIS EXISTS FOR: the model hub renders as a `contentOverride` inside
   * this same shell, so the sidebar stayed live while it was open — and picking
   * a chat switched the session underneath without ever taking the hub down.
   * You clicked New chat and kept looking at the model hub, with your new chat
   * behind it. Deliberately a callback rather than App watching the session id:
   * only a person navigating should pull the view, never a scheduled task
   * firing while someone browses models.
   */
  onEnterChat?: () => void;
}) {
  /*
   * THE SLIDE. the user: "left sidebar does not close cleanly, it's instant
   * dissapear and then slide left rather than the correct slide in like the
   * canvas sidebar does."
   *
   * MEASURED, before this: on the closing frame the panel left the DOM outright
   * (`if (!open) return null`) while the slot's width carried on animating
   * 272 → 0 for another ~280ms. So the content vanished at frame 0 and an empty
   * gap finished the animation by itself — exactly what he saw. The canvas rail
   * has always done the other thing: its width runs 158 → 0 while its content
   * stays 440px wide inside it, clipped as it goes.
   *
   * The movement itself is CSS (global.css, off the slot's own `data-open`, so
   * the panel's transform and the slot's width start on the same frame). All
   * this component owes it is the one thing CSS cannot do: keep the panel in the
   * tree until the slide is over. `exiting` does that, then lets it go — a
   * closed sidebar that stayed mounted would keep its buttons in the tab order.
   */
  const [exiting, setExiting] = useState(false);
  const prevOpen = useRef(open);
  useEffect(() => {
    const wasOpen = prevOpen.current;
    prevOpen.current = open;
    if (open) {
      setExiting(false);
      return;
    }
    // Only a panel that WAS open has anything to slide out; a sidebar that
    // starts closed must not animate itself away on first mount.
    if (!wasOpen) return;
    setExiting(true);
    const t = window.setTimeout(() => setExiting(false), slideMs() + 60);
    return () => window.clearTimeout(t);
  }, [open]);

  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const deletedFiles = useDeletedChats((s) => s.files);
  const [query, setQuery] = useState('');
  const currentFile = usePiStore((s) => s.session?.sessionFile ?? null);
  const sessionId = usePiStore((s) => s.session?.sessionId ?? null);
  // Fields for the optimistic row a brand-new chat needs before its file lands.
  const cwd = usePiStore((s) => s.session?.cwd ?? '');
  const windowTitle = usePiStore((s) => s.windowTitle);
  const messageCount = usePiStore((s) => s.messages.length);
  const firstUserText = usePiStore((s) => {
    const first = s.messages.find((m) => m.kind === 'user');
    return first !== undefined && first.kind === 'user' ? first.text : null;
  });
  // Fork branches are shown IN-THREAD via the ‹/› BranchSwitcher, never as their
  // own sidebar rows. pi:fork writes a real branch session file to disk, so without
  // this every edit-and-save would add a duplicate chat. Map each non-base branch
  // file → its group's base (files[0]); base files map to themselves.
  const branches = usePiStore((s) => s.branches);
  const { branchToBase, nonBaseBranchFiles } = useMemo(() => {
    const toBase = new Map<string, string>();
    const nonBase = new Set<string>();
    for (const group of Object.values(branches)) {
      const base = group.files[0];
      if (base === null || base === undefined) continue;
      group.files.forEach((f, i) => {
        if (f === null || i === 0) return;
        nonBase.add(f);
        toBase.set(f, base);
      });
    }
    return { branchToBase: toBase, nonBaseBranchFiles: nonBase };
  }, [branches]);
  // When viewing a branch, the BASE chat's row is the one that highlights / spins.
  const effectiveCurrentFile =
    currentFile !== null ? (branchToBase.get(currentFile) ?? currentFile) : null;

  // Is the (single, active) chat working? — the same signal the composer reads.
  // The app runs one pi session at a time, so only the active chat's row can show
  // a live spinner; when it goes idle we pop a per-row notice (see below).
  const isStreaming = usePiStore((s) => s.agent.isStreaming);
  const promptInFlight = usePiStore((s) => s.promptInFlight);
  const corpRunning = useCorpStore((s) => s.corpRunning);
  const busy = isStreaming || promptInFlight || corpRunning;
  // A chat generating in the BACKGROUND (the user is viewing another): its row —
  // not the viewed one — shows the spinner + gets the unread dot when it finishes.
  const bgRun = usePiStore((s) => s.bgRun);
  // Per-chat "unread" markers (blue = finished, orange = needs-input) shown as a dot
  // on the row until the user opens that chat. Only BACKGROUND chats get one — the
  // chat you're looking at needs no marker.
  const unread = usePiStore((s) => s.unread);
  const markUnread = usePiStore((s) => s.markUnread);

  // Child agents (subagents / roles running as their own pi instances) grouped by
  // their parent chat, for the nested dropdown. Expanded by default so a running
  // child is visible; a caret collapses it.
  const childrenByParent = useChildrenByParent();
  const viewedChildId = useChildAgentStore((s) => s.viewedChildId);
  const setViewedChild = useChildAgentStore((s) => s.setViewedChild);
  // A child that finished while unviewed leaves a blue dot on its row until opened.
  const childUnread = useChildAgentStore((s) => s.unread);
  // Running corp/hierarchy roles appear in the SAME nested dropdown under the chat
  // hosting the run; clicking one pins it so corp's own inline view shows it.
  const [collapsedParents, setCollapsedParents] = useState<Set<string>>(new Set());
  const toggleParent = (file: string) =>
    setCollapsedParents((prev) => {
      const next = new Set(prev);
      if (next.has(file)) next.delete(file);
      else next.add(file);
      return next;
    });

  // The "Modalities" dropdown — full-window studios reached from the sidebar.
  const setModalityView = useModalityStore((s) => s.setView);
  const [modalitiesOpen, setModalitiesOpen] = useState(true);
  /* Which rooms this person wants at all — the Capabilities setting, which the
     onboarding step also writes. See the rows below for why it is read here. */
  const caps = useSettingsStore((s) => s.settings.capabilities);
  // A planned workspace row (Training, Workflows) appears when its screen is
  // registered — follow the route registry (./workspace-nav.ts).
  useRouteViewsVersion();
  /*
   * TURNING A ROOM OFF WHILE STANDING IN IT PUTS YOU BACK IN THE CHAT.
   *
   * Otherwise the studio stays mounted with no way back to it and no row in the
   * sidebar — a screen you cannot leave and cannot return to, which is a worse
   * state than the one the setting was trying to create.
   */
  const modalityView = useModalityStore((s) => s.view);
  useEffect(() => {
    const off =
      (modalityView === 'image' && !caps.image) ||
      (modalityView === 'video' && !caps.video) ||
      (modalityView === 'audio' && !caps.audio) ||
      (modalityView === '3d' && !caps.threeD);
    if (off) setModalityView('chat');
  }, [modalityView, caps, setModalityView]);
  /* Whether the 3D module is on disk, so the row can say so before you click.
     `gen3d:module` is a DISK-ONLY check — asking the full catalog here would
     spawn the uv/Python sidecar for a user who may never open the studio. */
  const [module3d, setModule3d] = useState({ installed: true, remainingBytes: 0 });
  useEffect(() => {
    let live = true;
    void window.piDesktop
      .invoke('gen3d:module', undefined)
      .then((info) => {
        if (live) setModule3d(info);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  const moduleSize = formatModuleSize(module3d.remainingBytes);

  // Chat organization (B1/B2): projects, pins, renames, delete — persisted state.
  const org = useChatOrg();
  const hideDeleteConfirm = useSettingsStore((s) => s.settings.hideDeleteChatConfirm);
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(new Set());
  const toggleProject = (id: string) =>
    setCollapsedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  // Inline-rename targets (a chat file or a project id) + the live draft text.
  const [renamingFile, setRenamingFile] = useState<string | null>(null);
  const [renamingProject, setRenamingProject] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  // The chat pending a delete confirmation (null = dialog closed).
  const [deleteTarget, setDeleteTarget] = useState<SessionSummary | null>(null);
  const [dontAskDelete, setDontAskDelete] = useState(false);
  /*
   * What features add to a chat's ⋯ menu and to "Delete chat?" — memory's
   * "Forget what Bobble learned here", workflows' "Save as workflow…"
   * (./thread-menu-entries.ts). None until one registers.
   */
  const extraMenuEntries = useThreadMenuEntries();
  const deleteOptionDefs = useDeleteChatOptions();
  const [deleteChoices, setDeleteChoices] = useState<Record<string, boolean>>({});

  /*
   * The query main is currently searching bodies for.
   *
   * Debounced, and deliberately separate from `query`: the typed value drives
   * the title filter (instant, in memory) while this one drives a synchronous
   * main-process pass over every session file, which must not run per keystroke.
   */
  const [contentQuery, setContentQuery] = useState('');
  const contentQueryRef = useRef('');
  contentQueryRef.current = contentQuery;

  const refresh = useCallback(() => {
    void listSessions(undefined, contentQueryRef.current).then((list) => {
      setSessions(list);
      // Share it: the composer's project picker derives its list from the SAME
      // sessions, so both surfaces agree on what a project is (the user: nothing in
      // the dropdown that isn't in the sidebar).
      publishSessionList(list);
    });
  }, []);

  // Typing settles → ask main to search the bodies too.
  useEffect(() => {
    const q = query.trim();
    const id = setTimeout(() => setContentQuery(q), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [query]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: contentQuery is the trigger
  useEffect(() => {
    refresh();
  }, [contentQuery, refresh]);

  // Refresh on mount and whenever pi reports a session change (new turn/switch).
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionId is a refresh trigger
  useEffect(() => {
    refresh();
  }, [refresh, sessionId]);

  // A brand-new chat's session file is only written on its first turn, so re-list
  // when a turn starts/ends: the real disk row appears (replacing the optimistic
  // one) and its timestamp updates. `busy` is the trigger.
  // biome-ignore lint/correctness/useExhaustiveDependencies: busy is a refresh trigger
  useEffect(() => {
    refresh();
  }, [refresh, busy]);

  // A background chat finished (bgRun.streaming true→false) → mark ITS row unread so
  // a dot sits there until the user opens it. needs-input is marked when the request
  // arrives (see UiRequestHost), so it isn't downgraded here. The rule is
  // bg-run-watch.ts; a deleted chat's finish is neither.
  const bgWatch = useRef<BgRunWatch>(BG_RUN_IDLE);
  useEffect(() => {
    const look = watchBgRun(bgWatch.current, bgRun, Date.now(), isChatDeleted);
    bgWatch.current = look.watch;
    const finished = look.finished;
    if (finished !== null) {
      markUnread(finished.sessionFile, 'finished');
      /*
       * AND TELL THEM IF THEY ARE NOT HERE.
       *
       * The dot is right for "you are looking at the app". This is the other
       * case, and it is the one background chats exist for: the user went and
       * did something else. Main decides whether to actually show it (it knows
       * whether the window has focus; the renderer does not, reliably).
       *
       * THE DURATION FLOOR is what keeps it from being noise. A reply that took
       * two seconds is not something to interrupt someone for — they either
       * saw it or will in a moment.
       */
      if (finished.ranFor >= NOTIFY_MIN_RUN_MS) {
        void window.piDesktop
          .invoke('app:notify', {
            title: finished.title ?? 'A background chat finished',
            body: finished.title !== null ? 'It finished while you were away.' : 'It has a reply.',
            sessionFile: finished.sessionFile,
            kind: 'finished',
          })
          .catch(() => undefined);
      }
    }
  }, [bgRun, markUnread]);

  /*
   * A BACKGROUND CHAT THAT IS BLOCKED, which is the more urgent of the two.
   *
   * "Finished" can wait — the reply is there whenever the user comes back. A
   * chat sitting on `ask_user` is doing NOTHING until they answer, and there is
   * no duration floor for that: being blocked is worth saying immediately.
   */
  const notifiedNeedsInput = useRef<string | null>(null);
  useEffect(() => {
    const blocked = Object.entries(unread).find(([, kind]) => kind === 'needs-input');
    if (blocked === undefined) {
      notifiedNeedsInput.current = null;
      return;
    }
    const [file] = blocked;
    if (notifiedNeedsInput.current === file) return;
    notifiedNeedsInput.current = file;
    void window.piDesktop
      .invoke('app:notify', {
        title: 'A background chat needs you',
        body: 'It asked a question and is waiting for an answer.',
        sessionFile: file,
        kind: 'needs-input',
      })
      .catch(() => undefined);
  }, [unread]);

  /* The dock badge counts chats waiting on the user — the only signal left once
     the app is hidden entirely, and a count says more than a dot. */
  const unreadCount = Object.keys(unread).length;
  useEffect(() => {
    void window.piDesktop.invoke('app:set-badge', { count: unreadCount }).catch(() => undefined);
  }, [unreadCount]);

  // New chat starts a fresh session in the RUNNING pi (new_session RPC): it
  // resets the thread but does NOT dispose/respawn pi, so no "pi exited" crash
  // toast fires and nothing new bounces in the dock (the old restartPi path did
  // both). newSession() owns the store reset + custom-instructions re-arm.
  const onNewChat = useCallback(async () => {
    onEnterChat?.();
    await newSession();
    refresh();
  }, [refresh, onEnterChat]);

  /*
   * ⌘N, WHICH THE ROW HAS BEEN ADVERTISING WITHOUT ANYONE BINDING IT.
   *
   * MEASURED: press it anywhere in the app and the selected chat does not
   * change. The `<Kbd keys="⌘N" />` chip beside "New chat" is a promise the app
   * was not keeping — and a shortcut that silently does nothing is worse than
   * no shortcut, because you stop trusting the other hints too.
   *
   * Bound in the renderer rather than as a menu accelerator so it stays with
   * the control it belongs to. `preventDefault` because Chromium's own ⌘N is
   * "new window", which is not a thing this app has.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'n' && e.key !== 'N') return;
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      e.preventDefault();
      void onNewChat();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onNewChat]);

  // Start a fresh chat that belongs to a project, ROOTED at the project's working
  // folder (or, when it has none, a stable shared sandbox named after the project —
  // so all its projectless chats share files while the user only sees the project
  // name). newSession() first (it handles the streaming/capture + pointer sync);
  // then re-root that fresh session at the target folder (the selectPath pattern:
  // restartPi with the same sessionPath, an existing cwd wins in resolveSessionCwd).
  // The new session's file is only written on its first turn, but the assignment
  // persists against that path, so it appears under the project once it has content.
  const newChatInProject = useCallback(
    async (project: ChatProject) => {
      onEnterChat?.();
      await newSession();
      const file = usePiStore.getState().session?.sessionFile;

      // Group the new chat under the project IMMEDIATELY (assignChat writes the
      // org store optimistically) so its row appears INSIDE the project the
      // instant it's created — before the slower re-root round-trip.
      if (typeof file === 'string' && file.length > 0) await assignChat(file, project.id);

      let cwd = project.cwd;
      if (cwd === undefined || cwd.length === 0) {
        const res = await window.piDesktop
          .invoke('project:project-sandbox', { id: project.id })
          .catch(() => null);
        cwd = res?.path ?? undefined;
      }
      if (typeof cwd === 'string' && cwd.length > 0) {
        await restartPi({
          cwd,
          ...(typeof file === 'string' && file.length > 0 ? { sessionPath: file } : {}),
        });
      }

      // Keep the electron project (composer chip / canvas file-tree root) in step
      // for a real folder; a projectless project stays on the sandbox and the chip
      // shows the project name instead (see ComposerBar).
      if (project.cwd !== undefined && project.cwd.length > 0) {
        await window.piDesktop.invoke('project:set', { path: project.cwd }).catch(() => null);
        await useProjectStore
          .getState()
          .load()
          .catch(() => {});
      }
      refresh();
    },
    [refresh, onEnterChat],
  );

  // Attach a working folder to a project (native picker → persisted on the
  // ChatProject). New chats in it then root there instead of the shared sandbox.
  const setWorkingFolder = useCallback(
    async (project: ChatProject) => {
      const res = await window.piDesktop.invoke('project:pick-folder', undefined).catch(() => null);
      const picked = res?.path ?? null;
      if (picked === null) return;
      await setProjectCwd(project.id, picked);
      refresh();
    },
    [refresh],
  );

  // Drop a project's working folder → its chats fall back to the shared sandbox.
  const switchToSharedSandbox = useCallback(
    async (project: ChatProject) => {
      await setProjectCwd(project.id, null);
      refresh();
    },
    [refresh],
  );

  const onOpen = async (file: string) => {
    onEnterChat?.();
    const result = await switchSession(file);
    if (result.truncated) onTruncated();
    refresh();
  };

  /*
   * Clicking the notification opens the chat it was about, not just the window.
   *
   * Declared here rather than beside the other effects because `onOpen` is a
   * plain function defined above — a ref would work and would only be there to
   * satisfy the ordering.
   */
  useEffect(() => {
    return window.piDesktop.onEvent('app:notification-click', ({ sessionFile }) => {
      onEnterChat?.();
      void onOpen(sessionFile);
    });
  });

  // Optimistic row: a brand-new chat has no `.jsonl` until its first write, so it
  // wouldn't list. The instant it has content, show it immediately (the user: "appear
  // as soon as the first message is sent, that snappy") from the live session
  // pointer; the real disk row replaces it (same file key) on the next refresh.
  const displaySessions = useMemo(() => {
    // Hide fork-branch files (they belong to a base chat's ‹/› switcher), and
    // chats deleted this run — gone the frame Delete is pressed, whatever the
    // disk and the next listing are still doing (chat-delete.ts).
    let list = sessions.filter((s) => !nonBaseBranchFiles.has(s.file) && !deletedFiles.has(s.file));
    const now = new Date().toISOString();
    const optimisticRow = (file: string, title: string): SessionSummary => ({
      file,
      id: file === effectiveCurrentFile ? (sessionId ?? '') : '',
      cwd,
      cwdLabel: '',
      startedAt: now,
      modifiedAt: now,
      parentSession: null,
      supersedes: [],
      messageCount: file === effectiveCurrentFile ? messageCount : 0,
      firstUserText: file === effectiveCurrentFile ? firstUserText : null,
      title,
    });
    // A chat generating in the BACKGROUND that has no disk file yet (a new chat
    // still on its first turn) would otherwise vanish from the sidebar until its
    // reply lands — keep it visible + spinning via an optimistic row.
    if (
      bgRun?.streaming &&
      !deletedFiles.has(bgRun.sessionFile) &&
      !list.some((s) => s.file === bgRun.sessionFile || s.supersedes.includes(bgRun.sessionFile)) &&
      bgRun.sessionFile !== effectiveCurrentFile
    ) {
      list = [optimisticRow(bgRun.sessionFile, bgRun.title ?? 'New chat'), ...list];
    }
    /*
     * Optimistic row for the VIEWED brand-new chat — shows the INSTANT it's the
     * current session, even before its first message (the user: "instantly in the
     * sidebar the second we click new chat regardless"). The real disk row
     * replaces it (same file key) once the chat has content.
     *
     * `supersedes` is the other half of that match. pi forks a NEW session file
     * whenever it resumes, so after a model switch the store is still pointing at
     * the file it was told about while the listing shows the chain's tip — and a
     * row keyed on the old file would appear NEXT to it. Two rows for one chat is
     * precisely the duplication the chain collapsing exists to remove.
     */
    if (
      effectiveCurrentFile !== null &&
      !deletedFiles.has(effectiveCurrentFile) &&
      !list.some(
        (s) => s.file === effectiveCurrentFile || s.supersedes.includes(effectiveCurrentFile),
      )
    ) {
      list = [
        optimisticRow(effectiveCurrentFile, windowTitle ?? firstUserText ?? 'New chat'),
        ...list,
      ];
    }
    return list;
  }, [
    sessions,
    nonBaseBranchFiles,
    deletedFiles,
    effectiveCurrentFile,
    sessionId,
    cwd,
    messageCount,
    firstUserText,
    windowTitle,
    bgRun,
  ]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    /*
     * A chat matches on its TITLE (which the renderer owns, because it knows
     * about renames) or on its BODY (which main found while reading the file it
     * was already reading). Searching titles alone meant the chat you remember
     * by something that was SAID in it was the one you could not get back to —
     * the title is just the first message cut to 80 characters.
     */
    const list =
      q.length === 0
        ? displaySessions
        : displaySessions.filter(
            (s) => displayTitle(s, org).toLowerCase().includes(q) || s.match !== undefined,
          );
    return list.slice(0, 50);
  }, [displaySessions, query, org]);

  // Partition the flat list into project groups + ungrouped (pinned float to top).
  const grouped = useMemo(() => groupChats(filtered, org), [filtered, org]);

  // ── Inline rename + delete helpers (B2) ────────────────────────────────────
  const beginRenameChat = (s: SessionSummary) => {
    setRenamingProject(null);
    setRenamingFile(s.file);
    setRenameDraft(displayTitle(s, org));
  };
  const commitRenameChat = () => {
    if (renamingFile !== null) void renameChat(renamingFile, renameDraft);
    setRenamingFile(null);
  };
  const beginRenameProject = (id: string, name: string) => {
    setRenamingFile(null);
    setRenamingProject(id);
    setRenameDraft(name);
  };
  const commitRenameProject = () => {
    if (renamingProject !== null) void renameProject(renamingProject, renameDraft);
    setRenamingProject(null);
  };
  /**
   * Export one chat. The TITLE comes from here rather than from main, which
   * does not know about renames — exporting under a name the user changed six
   * weeks ago is exactly the small wrongness that makes an export untrustworthy.
   */
  const exportChat = async (
    s: SessionSummary,
    format: 'markdown' | 'jsonl',
    to: 'file' | 'clipboard',
  ): Promise<void> => {
    const res = await window.piDesktop
      .invoke('fs:export-session', { file: s.file, format, title: displayTitle(s, org), to })
      .catch(() => ({ ok: false }) as { ok: boolean; text?: string });
    if (to === 'clipboard' && res.ok && typeof res.text === 'string') {
      await writeClipboardText(res.text);
    }
  };

  /** The chat a registered menu row or delete option is told about. */
  const menuContext = (s: SessionSummary): ThreadMenuContext => ({
    file: s.file,
    title: displayTitle(s, org),
    pinned: org.pinned.includes(s.file),
    projectId: org.assignments[s.file],
  });
  const deleteOptionsFor = (s: SessionSummary): readonly DeleteChatOption[] => {
    if (deleteOptionDefs.length === 0) return [];
    const ctx = menuContext(s);
    return deleteOptionDefs.filter((o) => o.visible?.(ctx) ?? true);
  };

  // Delete: skip the dialog when the user chose "don't ask again". Either way the
  // row is gone at once and the chat's work stops; the disk catches up behind.
  // A feature's delete options run either way — with their defaults when the
  // dialog was skipped.
  const requestDeleteChat = (s: SessionSummary) => {
    if (hideDeleteConfirm) {
      void deleteChatNow({ ...s, title: displayTitle(s, org) }).then(refresh);
      if (deleteOptionDefs.length > 0) void runDeleteOptions(menuContext(s), undefined);
      return;
    }
    setDontAskDelete(false);
    if (deleteOptionDefs.length > 0) {
      const ctx = menuContext(s);
      setDeleteChoices(
        Object.fromEntries(deleteOptionsFor(s).map((o) => [o.id, o.defaultChecked(ctx)])),
      );
    }
    setDeleteTarget(s);
  };
  const confirmDeleteChat = () => {
    if (deleteTarget === null) return;
    const target = deleteTarget;
    setDeleteTarget(null);
    if (dontAskDelete) void useSettingsStore.getState().update({ hideDeleteChatConfirm: true });
    void deleteChatNow({ ...target, title: displayTitle(target, org) }).then(refresh);
    if (deleteOptionDefs.length > 0) void runDeleteOptions(menuContext(target), deleteChoices);
  };
  const createProjectAndAssign = async (file?: string) => {
    const id = await createProject('New project');
    if (file !== undefined) await assignChat(file, id);
    beginRenameProject(id, 'New project');
  };

  /** One chat row: the A4 icon-swap row + its hover 3-dot menu (B2) + the nested
   * agent dropdown (A3/A4). Shared by the project groups and the ungrouped list. */
  const renderChat = (s: SessionSummary): ReactNode => {
    /*
     * "Is this row the chat the app is pointing at?" — which is not the same as
     * "is it the same FILE". pi forks a new session file on every resume, so
     * after a model switch the store still names the ancestor while this row is
     * the chain's tip. Matching only on `file` left the selection and the running
     * spinner on a row that is no longer listed.
     */
    const isThisChat = (file: string | null): boolean =>
      file !== null && (file === s.file || s.supersedes.includes(file));
    const running =
      (busy && bgRun === null && isThisChat(effectiveCurrentFile)) ||
      (bgRun?.streaming === true && isThisChat(bgRun.sessionFile));
    const unreadKind = unread[s.file];
    const kids = childrenByParent.get(s.file) ?? [];
    /*
     * A TEAM YOU CAN GO BACK TO. This was gated on `corpRunning`, so the moment a
     * run finished every role vanished from the sidebar and there was no way to
     * re-open what any of them had done — the opposite of the whole point, which
     * is that these are chats. A child agent's rows survive its run; so do these.
     * Still scoped to the chat that hosts the run: another conversation's team is
     * not this conversation's business.
     */
    /*
     * Corp roles are CHILDREN now — mirrored into the child-agent store by
     * `syncCorpChildren`, so they arrive in `kids` with every other subagent and
     * open as chats. There used to be a second row type here that only pinned a
     * node in the situation room: it looked exactly like a subchat and did not
     * open one, which is the whole of the user's complaint. One row type, one way to
     * view a team member.
     */
    const hasKids = kids.length > 0;
    const expanded = hasKids && !collapsedParents.has(s.file);
    const isFocused = isThisChat(effectiveCurrentFile) && viewedChildId === null;
    const title = displayTitle(s, org);
    const pinned = org.pinned.includes(s.file);
    const assignedTo = org.assignments[s.file];
    // What a registered ⋯ menu row is told about this chat (none registered: skip).
    const menuCtx = extraMenuEntries.length === 0 ? null : menuContext(s);

    // Editing → the row becomes an inline rename input.
    if (renamingFile === s.file) {
      return (
        <div key={s.file} className="px-2 py-0.5">
          <input
            className="pd-chat-rename-input pd-focusable"
            data-testid={`chat-rename-input-${title}`}
            ref={(el) => el?.focus()}
            value={renameDraft}
            onChange={(e) => setRenameDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRenameChat();
              else if (e.key === 'Escape') setRenamingFile(null);
            }}
            onBlur={commitRenameChat}
          />
        </div>
      );
    }

    return (
      <div key={s.file} className="pd-chatrow">
        {/* The row and its hover actions share a positioning context of their OWN.
            They used to sit directly in `.pd-chatrow`, which also holds the nested
            agent rows — so the absolutely-positioned actions overlay (top:0;
            bottom:0) stretched over the children too. Two symptoms, one cause: the
            3 dots centred themselves over the whole block and drifted down beside
            a child row, and on hover their `pointer-events:auto` layer covered the
            child rows, so a subagent could not be clicked (the user: "the 'Pi' subchat
            which itself is not clickable to show"). Bounding them to the row fixes
            both. */}
        <div className="pd-chatrow-main">
          <SidebarRow
            // No caret by default; a chat with agents swaps its bubble for a fold
            // caret ON HOVER (CSS) so nothing shifts (the user A4).
            /*
             * NO BUBBLE ON A PLAIN CHAT. the user: "chat icon on the left felt very
             * generic, do we even need that icon for each chat?" — and no: an
             * identical glyph on every row of a list of chats distinguishes
             * nothing, while costing ~24px of a column whose titles were all
             * truncating to "Build me a fully functional …".
             *
             * A chat WITH agents keeps it, because there the glyph is a control:
             * it swaps to the fold caret on hover. Those rows sit slightly
             * proud of the rest, which is what a row that opens into other rows
             * should look like.
             */
            icon={
              hasKids ? (
                <span className="pd-chat-icon-swap">
                  <IconChat size={16} className="pd-chat-icon-bubble" />
                  <IconChevronDown
                    size={14}
                    className={`pd-chat-icon-caret ${expanded ? '' : '-rotate-90'}`}
                  />
                </span>
              ) : undefined
            }
            label={title}
            // Priority: needs-input dot > running spinner > finished dot > pin glyph > time.
            meta={
              unreadKind === 'needs-input' ? (
                <span className="pd-chat-dot pd-chat-dot--needs-input" />
              ) : running ? (
                // Sized + placed to land exactly on the hover 3-dot button
                // (the user) — see .pd-chatrow-spinner.
                <span className="pd-chatrow-spinner">
                  <Spinner size={16} />
                </span>
              ) : unreadKind === 'finished' ? (
                <span className="pd-chat-dot pd-chat-dot--finished" />
              ) : pinned ? (
                <IconPin size={13} className="text-text-muted" />
              ) : (
                relativeTime(s.modifiedAt)
              )
            }
            selected={isFocused}
            data-testid={`chat-row-${title}`}
            onClick={() => {
              if (isFocused && hasKids) {
                toggleParent(s.file);
                return;
              }
              setViewedChild(null);
              void onOpen(s.file);
            }}
          />
          {/* WHY THIS ROW MATCHED. Without the excerpt a content hit is a chat
              whose title has nothing to do with what was typed, which reads as a
              broken search rather than a found conversation. Shown only when the
              title does NOT already contain the query — then the row explains
              itself. */}
          {s.match !== undefined && !title.toLowerCase().includes(query.trim().toLowerCase()) ? (
            <div className="pd-chat-excerpt" data-testid={`chat-excerpt-${title}`}>
              {s.match.excerpt}
            </div>
          ) : null}
          {/* Hover-revealed 3-dot menu. A SIBLING of the row button (not nested) so
            it's valid HTML; :focus-within keeps it up while the menu is open. */}
          <div className="pd-chatrow-actions">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="pd-chatrow-dots pd-focusable"
                  aria-label="Chat actions"
                  data-testid={`chat-menu-${title}`}
                >
                  <IconMore size={16} />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                side="bottom"
                sideOffset={4}
                className="min-w-[190px]"
              >
                <DropdownMenuItem
                  icon={<IconPencil size={16} />}
                  onSelect={() => beginRenameChat(s)}
                >
                  Rename
                </DropdownMenuItem>
                <DropdownMenuItem
                  icon={<IconPin size={16} />}
                  onSelect={() => void togglePin(s.file)}
                >
                  {pinned ? 'Unpin' : 'Pin'}
                </DropdownMenuItem>
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger icon={<IconFolderPlus size={16} />}>
                    Add to project
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="min-w-[180px]">
                    {org.projects.length === 0 ? (
                      <DropdownMenuItem disabled>No projects yet</DropdownMenuItem>
                    ) : (
                      org.projects.map((p) => (
                        <DropdownMenuItem
                          key={p.id}
                          hint={assignedTo === p.id ? '✓' : undefined}
                          onSelect={() => void assignChat(s.file, p.id)}
                        >
                          {p.name}
                        </DropdownMenuItem>
                      ))
                    )}
                    {assignedTo !== undefined ? (
                      <DropdownMenuItem onSelect={() => void assignChat(s.file, null)}>
                        Remove from project
                      </DropdownMenuItem>
                    ) : null}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      icon={<IconPlus size={16} />}
                      onSelect={() => void createProjectAndAssign(s.file)}
                    >
                      New project…
                    </DropdownMenuItem>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                {/*
                  A CHAT YOU CAN KEEP.

                  Everything here is already a real file on disk and there was
                  still no way to get a conversation out — not into a note, not
                  to a colleague, not into a commit message. Markdown is for a
                  person; the raw JSONL is the session verbatim, for anything
                  that reads it back, this app included.
                */}
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger icon={<IconShare size={16} />}>
                    Export
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="min-w-[190px]">
                    <DropdownMenuItem
                      onSelect={() => void exportChat(s, 'markdown', 'file')}
                      data-testid={`chat-export-md-${title}`}
                    >
                      Save as Markdown…
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => void exportChat(s, 'jsonl', 'file')}>
                      Save raw JSONL…
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onSelect={() => void exportChat(s, 'markdown', 'clipboard')}
                      data-testid={`chat-copy-${title}`}
                    >
                      Copy to clipboard
                    </DropdownMenuItem>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                {menuCtx === null
                  ? null
                  : threadMenuEntriesFor(extraMenuEntries, menuCtx).map((entry) => (
                      <DropdownMenuItem
                        key={entry.id}
                        icon={entry.icon}
                        danger={entry.danger}
                        data-testid={entry.testid?.(menuCtx)}
                        onSelect={() => entry.onSelect(menuCtx)}
                      >
                        {typeof entry.label === 'function' ? entry.label(menuCtx) : entry.label}
                      </DropdownMenuItem>
                    ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  danger
                  icon={<IconTrash size={16} />}
                  onSelect={() => requestDeleteChat(s)}
                >
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        {expanded ? (
          <div className="pd-child-rows" data-testid="child-rows">
            {kids.map((c) => (
              <button
                type="button"
                key={c.childId}
                className="pd-child-row pd-focusable"
                data-testid={`child-row-${c.childId}`}
                data-selected={viewedChildId === c.childId || undefined}
                onClick={() => {
                  onEnterChat?.();
                  setViewedChild(c.childId);
                }}
              >
                <span className="pd-child-row-icon">
                  <IconChat size={13} />
                </span>
                <span className="pd-child-row-label">{c.title}</span>
                {/* The situation room's own lifecycle word, on the row. Without
                    it the sidebar could only say "spinning" or "not spinning",
                    which is why a finished agent and a never-started one looked
                    identical here.
                    Shown while RUNNING too: "working" is one of the words the user
                    asked for, and a spinner alone says something is happening
                    without saying what. The spinner keeps its own job (liveness);
                    the word carries the state. */}
                {c.statusLabel !== undefined ? (
                  /* The word was already here; the DOT is what the user asked for —
                     "red error, green completed and waiting, and yellow paused…
                     simple circles faint tint or glow maybe, very faint". Tone
                     comes off the word itself so the sidebar and the situation
                     room cannot disagree about what colour a state is. */
                  <span className="pd-child-row-status" data-why={statusTone(c.statusLabel)}>
                    {statusTone(c.statusLabel) !== undefined ? (
                      <span className="pd-child-row-dot" aria-hidden />
                    ) : null}
                    {c.statusLabel}
                  </span>
                ) : null}
                {c.running ? (
                  <Spinner size={12} />
                ) : childUnread[c.childId] !== undefined ? (
                  <span className="pd-chat-dot pd-chat-dot--finished" />
                ) : null}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    );
  };

  // Round-5 #22 / round-8 #4/#5: Workspace nav above the Chats list. Artifacts
  // removed; "Model management" routes to the settings model-manager surface
  // (section id `models` is the seam the parallel model-manager rework owns);
  // the redundant Settings entry is gone (it lives in the profile footer).
  // The rows are the workspace-nav registry now (./workspace-nav.ts): the
  // three that ship, and the planned ones that appear once their screen does.
  const workspaceNavContext: WorkspaceNavContext = {
    onOpenSettings,
    onOpenConnectors,
    onOpenScheduled,
    navigate,
  };
  const workspaceNav = workspaceNavRows({ capabilities: caps });

  /*
   * COLLAPSED: NOTHING — eventually. the user: "when we close the left sidebar now
   * it just completely closes, right border of the left sidebar just slides to
   * the left like a curtain and the whole thing dissapears, button stays fixed
   * up right next to the traffic light buttons."
   *
   * There is no icon rail, and the toggle that brings the sidebar back lives in
   * the shell (ChatApp), not in here — a control that has to survive this
   * component unmounting cannot be rendered by it.
   *
   * The panel does still have to be HERE for the length of the curtain, though,
   * or the thing sliding left is an empty gap. `exiting` holds it that long;
   * `justClosed` covers the one render between `open` flipping and that effect
   * running, which would otherwise unmount it before the slide ever started.
   */
  const justClosed = !open && prevOpen.current;
  if (!open && !exiting && !justClosed) return null;

  // ── EXPANDED: the full sidebar ─────────────────────────────────────────────
  return (
    /*
     * `data-open` stays TRUE for as long as the panel is mounted: it is the full
     * sidebar the whole time, including while it slides out. The SLOT (ChatApp)
     * is the single source of truth for open/closed — it owns the width, the
     * clip, and (via a descendant rule) where the panel is parked.
     */
    <Sidebar open>
      {/* Traffic-light clearance strip (draggable). The collapse toggle moved OUT
          of the sidebar entirely — it now sits beside the macOS lights in the
          shell, so it survives the sidebar unmounting. */}
      <div className="pd-sidebar-tl h-[var(--pd-height-topbar)] shrink-0 [-webkit-app-region:drag]" />

      {/* Identity: the app mark + wordmark, above the search. */}
      <div className="flex items-center gap-2 px-3 pb-2" data-testid="sidebar-identity" aria-hidden>
        <BobbleMark size={28} />
        <span className="pd-wordmark text-text-primary">Bobble</span>
      </div>

      <div className="pd-sidebar-search-wrap px-2 pb-2">
        <div className="min-w-0 flex-1" data-testid="sidebar-search">
          <CollapsibleSearch placeholder="Search chats" value={query} onChange={setQuery} />
        </div>
      </div>

      <SidebarScroll>
        {/* The rail's one lead action (sidebar.css). */}
        <SidebarRow
          className="pd-sidebar-row--lead"
          icon={<Glyph name="newChat" />}
          label="New chat"
          meta={<Kbd keys="⌘N" />}
          onClick={() => void onNewChat()}
          data-testid="new-chat"
        />

        <SidebarSection label="Workspace">
          {workspaceNav.map((item) => (
            <SidebarRow
              key={item.id}
              icon={<Glyph name={item.glyph} />}
              label={item.label}
              onClick={() => item.onClick(workspaceNavContext)}
              data-testid={item.testid}
            />
          ))}
        </SidebarSection>

        {/*
          Modalities — full-window studios (3D, image, video, audio). A section
          like Workspace, whose header also folds it, so more can be added without
          crowding the rail.

          It was a ROW with a chevron over an indented tree of 13px rows — the
          grammar the project folders use for their chats — so the studios read
          as the contents of a folder called Modalities, and the header read as
          one more item (14px, the rows' own ink) between two real section labels
          (the user 2026-09-24: "do you see the lack of hierarchy"). The header is now
          the section label every other group wears, and the studios are the same
          rows as Workspace: places, side by side.

          NO ICON on the header. Three attempts — the 3D cube (which named one of
          the four things below it), three loose primitives, then a wand — and
          the user rejected each: this is a disclosure for rows that each carry their
          own icon, so any glyph here is a fifth medium or a decoration.
        */}
        <div className="pd-sidebar-section" data-testid="modalities">
          <button
            type="button"
            className="pd-sidebar-section-header pd-sidebar-section-toggle pd-focusable"
            data-testid="modalities-toggle"
            aria-expanded={modalitiesOpen}
            onClick={() => setModalitiesOpen((o) => !o)}
          >
            <span>Modalities</span>
            <IconChevronDown size={12} className={modalitiesOpen ? '' : '-rotate-90'} />
          </button>
          {modalitiesOpen ? (
            <div data-testid="modality-rows">
              {/*
               * THE CAPABILITIES SETTING DECIDES WHICH ROOMS EXIST.
               *
               * Distinct from the module/engine gate below it, and the two are
               * often confused: "not installed" is a fact about this machine
               * that the room itself explains and offers to fix, while this is
               * a CHOICE — someone said in onboarding or in Settings that they
               * do not want video, and a Video row is then just clutter.
               *
               * Found in the round-2 settings stress run: those four checkboxes
               * were persisted and read by nobody, so unticking one changed
               * nothing anywhere in the app. See the default in settings-store.
               */}
              {caps.threeD ? (
                <SidebarRow
                  icon={<Glyph name="studio3d" />}
                  label="3D Studio"
                  meta={
                    !module3d.installed && moduleSize !== '' ? (
                      <span data-testid="modality-3d-size">{moduleSize}</span>
                    ) : undefined
                  }
                  data-testid="modality-3d"
                  data-installed={module3d.installed}
                  title={
                    module3d.installed
                      ? '3D Studio'
                      : `3D Studio · module not installed${
                          moduleSize === '' ? '' : ` (${moduleSize})`
                        }`
                  }
                  onClick={() => setModalityView('3d')}
                />
              ) : null}
              {/*
               * THE THREE STUDIOS. Openable whether or not their engine is
               * installed, for the same reason the 3D row is: the surface itself
               * explains what is missing and where to get it, which is a better
               * answer than a row that will not click.
               *
               * Each names what it MAKES. "Studio" sitting under "3D Studio"
               * read as one thing and its 3D variant rather than separate rooms.
               */}
              {caps.image ? (
                <SidebarRow
                  icon={<Glyph name="image" />}
                  label="Image"
                  data-testid="modality-image"
                  title="Image Studio"
                  onClick={() => setModalityView('image')}
                />
              ) : null}
              {caps.video ? (
                <SidebarRow
                  icon={<Glyph name="video" />}
                  label="Video"
                  data-testid="modality-video"
                  title="Video Studio"
                  onClick={() => setModalityView('video')}
                />
              ) : null}
              {caps.audio ? (
                <SidebarRow
                  icon={<Glyph name="audio" />}
                  label="Audio"
                  data-testid="modality-audio"
                  title="Audio Studio"
                  onClick={() => setModalityView('audio')}
                />
              ) : null}
            </div>
          ) : null}
        </div>

        {/* Projects (B1) — Codex-style named groups; each folds to reveal its
            chats. The "+" adds a project (then opens it for inline rename). */}
        <SidebarSection
          label="Projects"
          actions={
            <button
              type="button"
              className="pd-section-action pd-focusable"
              aria-label="New project"
              data-testid="new-project"
              onClick={() => void createProjectAndAssign()}
            >
              <IconPlus size={14} />
            </button>
          }
        >
          {grouped.projects.length === 0 ? (
            <div className="px-2 py-1.5 text-footnote text-text-muted">No projects yet.</div>
          ) : (
            grouped.projects.map(({ project, chats, auto }) => {
              const pExpanded = !collapsedProjects.has(project.id);
              if (renamingProject === project.id) {
                return (
                  <div key={project.id} className="px-2 py-0.5">
                    <input
                      className="pd-chat-rename-input pd-focusable"
                      data-testid={`project-rename-input-${project.id}`}
                      ref={(el) => el?.focus()}
                      value={renameDraft}
                      onChange={(e) => setRenameDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitRenameProject();
                        else if (e.key === 'Escape') setRenamingProject(null);
                      }}
                      onBlur={commitRenameProject}
                    />
                  </div>
                );
              }
              return (
                <div key={project.id}>
                  {/* Auto (directory-derived) folders have no menu — they re-derive
                      from the working dir. Only user-made projects rename/delete.

                      `pd-chatrow-main` MATTERS, and its absence was a real bug:
                      the hover actions are `opacity: 0; pointer-events: none`
                      until `.pd-chatrow-main:hover`, and a project row put them
                      OUTSIDE that element — a sibling of the row rather than a
                      descendant of it. So a project's "+" and its ⋯ could never
                      be revealed and never be clicked: no rename, no delete, no
                      working folder, no new chat in a project, from the sidebar
                      at all. A chat row has always nested them correctly (see
                      the .pd-chatrow-main above); this now matches it. */}
                  <div className={auto ? '' : 'pd-chatrow pd-chatrow-main'}>
                    <SidebarRow
                      /* The folder IS the state: closed while the project is
                         folded, open once it is not, morphing between the two
                         (FolderGlyph) — so no caret swap on hover here. */
                      icon={<FolderGlyph open={pExpanded} />}
                      label={project.name}
                      meta={
                        <span className="text-text-muted">
                          {chats.length > 0 ? chats.length : ''}
                        </span>
                      }
                      data-testid={`project-row-${project.id}`}
                      onClick={() => toggleProject(project.id)}
                    />
                    {auto ? null : (
                      <div className="pd-chatrow-actions">
                        <button
                          type="button"
                          className="pd-chatrow-dots pd-focusable"
                          aria-label="New chat in this project"
                          title="New chat in this project"
                          data-testid={`project-new-chat-${project.id}`}
                          onClick={() => void newChatInProject(project)}
                        >
                          <IconPlus size={16} />
                        </button>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <button
                              type="button"
                              className="pd-chatrow-dots pd-focusable"
                              aria-label="Project actions"
                              data-testid={`project-menu-${project.id}`}
                            >
                              <IconMore size={16} />
                            </button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" side="bottom" sideOffset={4}>
                            <DropdownMenuItem
                              icon={<IconPencil size={16} />}
                              onSelect={() => beginRenameProject(project.id, project.name)}
                            >
                              Rename project
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              icon={<IconFolderPlus size={16} />}
                              onSelect={() => void setWorkingFolder(project)}
                            >
                              {project.cwd ? 'Change working folder…' : 'Set working folder…'}
                            </DropdownMenuItem>
                            {project.cwd ? (
                              <DropdownMenuItem
                                onSelect={() => void switchToSharedSandbox(project)}
                              >
                                Use shared sandbox
                              </DropdownMenuItem>
                            ) : null}
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              danger
                              icon={<IconTrash size={16} />}
                              onSelect={() => void deleteProject(project.id)}
                            >
                              Delete project
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    )}
                  </div>
                  <ProjectChats open={pExpanded} projectId={project.id}>
                    {chats.length === 0 ? (
                      <div className="px-2 py-1 text-footnote text-text-muted">Empty</div>
                    ) : (
                      chats.map(renderChat)
                    )}
                  </ProjectChats>
                </div>
              );
            })
          )}
        </SidebarSection>

        <SidebarSection label="Chats">
          {filtered.length === 0 ? (
            <div className="px-2 py-1.5 text-footnote text-text-muted">
              {query.trim().length > 0 ? 'No matching chats.' : 'No chats yet.'}
            </div>
          ) : grouped.ungrouped.length === 0 ? (
            <div className="px-2 py-1.5 text-footnote text-text-muted">
              All chats are in projects.
            </div>
          ) : (
            grouped.ungrouped.map(renderChat)
          )}
        </SidebarSection>
      </SidebarScroll>

      {/* Delete-chat confirmation (B2), skippable via "Don't ask again". */}
      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(o) => {
          if (!o) setDeleteTarget(null);
        }}
      >
        <DialogContent data-testid="delete-chat-dialog" className="max-w-[400px]">
          <DialogHeader>
            <DialogTitle>Delete chat?</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <p className="text-body text-text-secondary">
              “{deleteTarget !== null ? displayTitle(deleteTarget, org) : ''}” will be permanently
              deleted. This can’t be undone.
            </p>
            <label
              htmlFor="delete-chat-dontask"
              className="flex cursor-pointer items-center gap-2 text-footnote text-text-muted"
            >
              <Checkbox
                id="delete-chat-dontask"
                checked={dontAskDelete}
                onCheckedChange={(v) => setDontAskDelete(v === true)}
                data-testid="delete-chat-dontask"
              />
              Don’t ask again
            </label>
            {deleteTarget === null
              ? null
              : deleteOptionsFor(deleteTarget).map((option) => (
                  <label
                    key={option.id}
                    htmlFor={`delete-chat-option-${option.id}`}
                    className="flex cursor-pointer items-center gap-2 text-footnote text-text-muted"
                  >
                    <Checkbox
                      id={`delete-chat-option-${option.id}`}
                      checked={deleteChoices[option.id] === true}
                      onCheckedChange={(v) =>
                        setDeleteChoices((c) => ({ ...c, [option.id]: v === true }))
                      }
                      data-testid={option.testid}
                    />
                    {option.label}
                  </label>
                ))}
          </DialogBody>
          <DialogFooter>
            <button
              type="button"
              className="pd-btn-ghost pd-focusable"
              onClick={() => setDeleteTarget(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="pd-btn-danger pd-focusable"
              data-testid="delete-chat-confirm"
              onClick={() => void confirmDeleteChat()}
            >
              Delete
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bottom-left footer: the profile dropup plus a one-click gear. Equal
          inset both sides so the hover wash is a full-width row rather than a
          pill floating off-centre. */}
      <div className="pd-sidebar-footer-row">
        <SidebarProfileMenu variant="full" onOpenSettings={onOpenSettings} />
        <button
          type="button"
          data-testid="footer-settings"
          aria-label="Settings"
          title="Settings"
          onClick={() => onOpenSettings('personalization')}
          className="pd-sidebar-footer-gear pd-focusable"
        >
          <IconSettings size={16} />
        </button>
      </div>
    </Sidebar>
  );
}
