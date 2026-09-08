/**
 * THE CLI GROUP REGISTRY — every group the tool-CLI offers, in one pure module.
 *
 * `tool-cli.ts` knows how to turn a group spec into commands; `capabilities.ts`
 * knows the capability groups. This is the third piece: the groups that are NOT
 * capabilities but still have to be reachable as commands, and the join of the
 * two that is the whole surface.
 *
 * It lives on its own — rather than in the extension closure where it started —
 * because the ANSWER to "is `mac snapshot` a tool invocation or a shell command"
 * is needed outside the extension process too. The desktop's Activity tab shows
 * a real bash command in a terminal and a tool invocation as that tool, and the
 * only honest way to tell them apart is the list of shims actually installed on
 * PATH. Deriving that list here means the renderer reads the SAME registry the
 * shims are written from, so a new group cannot appear on PATH without the UI
 * knowing about it.
 *
 * Dependency-free by construction (the same discipline as
 * `@pi-desktop/browser-use/tool-names`): nothing here imports a runtime, so a
 * renderer can import it without dragging the pi SDK into its bundle.
 */
import { TALK_TO_MANAGER } from '../corp/promotion.js';
import { CAPABILITIES } from '../presets/capabilities.js';
import { SPAWN_SUBAGENT_TOOL_NAME } from '../subagent/types.js';
import { type CliGroupSpec, commandNameFor } from './tool-cli.js';

/*
 * The two harness tools that are not a capability but still have to be
 * reachable. They get their own single-command groups rather than being
 * pushed into someone else's.
 */
/**
 * THE FOUR THAT COST 8,516 CHARACTERS AND ARE NOT CAPABILITIES.
 *
 * `ask_user`, `update_plan`, `spawn_subagent` and `talk_to_manager` were four
 * of the five most expensive schemas in the prompt (3,584 + 2,217 + 1,443 +
 * 1,272 chars, MEASURED off the real request body) — 42% of the entire tool
 * budget, riding every single turn including one that just asks the time.
 *
 * They are also the four the model answered with when a blind tester asked
 * what it could do, which is not a coincidence: they were a fifth of what it
 * had been told about itself. Her words: "That's internal machinery. It's like
 * asking a colleague what they do and being told 'I can hold meetings and
 * delegate.'"
 *
 * the user, on the proposal to delete them: "don't remove these, but put them
 * under a differently named cli eg. contract and communicate or something."
 *
 * That was a GROUPING instruction for this mode, and I first read it as
 * licence to build a hybrid — these four behind a CLI while everything else
 * stayed schemas. He corrected it: "the entire point of the bash cli *mode*
 * is that it's a mode … it's not like this needs to be done for 2 tools but
 * keep some others as the always loaded schemas." The hybrid is reverted; the
 * grouping stands.
 *
 * ONE GROUP, and `coordinate` is the honest word for it: every one of the four
 * is this agent settling something with somebody else — the user, a subagent,
 * the manager — or stating what it is about to do. They were three groups
 * (`ask`, `plan`, `team`); three one-command groups is a taxonomy nobody needs
 * to learn.
 */
export const TOOL_CLI_COORDINATE_GROUP: CliGroupSpec = {
  name: 'coordinate',
  summary:
    'Ask the user something, publish your plan, hand work to a subagent, or contract ' +
    'large tasks that are not feasible to complete on your own.',
  tools: ['ask_user', 'update_plan', SPAWN_SUBAGENT_TOOL_NAME, TALK_TO_MANAGER],
};

export const TOOL_CLI_EXTRA_GROUPS: readonly CliGroupSpec[] = [
  TOOL_CLI_COORDINATE_GROUP,
  /*
   * THE FENCED FILE TOOLS, BY NAME.
   *
   * Every accumulated file-safety fix hangs off the harness's `write`/`edit`
   * overrides — the sandbox write fence, `guardDestructiveRewrite`,
   * `stripCodeFence`, `repairDroppedRootSlash`, the failed-edit diagnosis —
   * and in this mode `bash` was the only advertised tool, so none of them ran.
   * Shell redirection is the alternative and it is unfenced by nature.
   *
   * Bash already spawns with `cwd` set to the workspace root, so a RELATIVE
   * `cat > notes.md` lands in the right place; the exposure is absolute and
   * `~/…` paths, plus losing every repair above. Giving the fenced path a name
   * is the part that is mechanism. The preamble points at it; a model that
   * still redirects is not something a command list can prevent.
   */
  {
    name: 'file',
    summary: 'Read, write, edit and list files — the safe path, and the one that repairs itself.',
    tools: ['read', 'write', 'edit', 'ls'],
  },
];
/** Every group the CLI offers: the capabilities, plus the extras above. */
export const toolCliGroups = (): CliGroupSpec[] => [...CAPABILITIES, ...TOOL_CLI_EXTRA_GROUPS];

/**
 * THE COMMANDS THAT EXIST ON PATH — `tools`, plus one shim per group.
 *
 * This is the exact list `registerToolCli` writes into the shim directory, so it
 * is the ground truth for "is this word one of ours". It is deliberately the
 * GROUP names and not the tool names: you type `file read notes.md`, never
 * `read notes.md`, and `ls` is a tool inside the `file` group precisely because
 * a shim called `ls` would shadow the real one. That distinction is what lets
 * `ls -la` still be a shell command.
 */
export function toolCliShimCommands(specs: readonly CliGroupSpec[] = toolCliGroups()): string[] {
  return ['tools', ...specs.map((spec) => commandNameFor(spec.name))];
}
