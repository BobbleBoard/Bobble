/**
 * THE STUDIO'S MAIN SIDE: start ComfyUI, run one graph, hand back the file.
 *
 * The pieces all existed already and had never been joined: `createComfySupervisor`
 * knows how to spawn and health-check the server, `ComfyClient` knows how to
 * queue a graph and collect its outputs, and `WORKFLOW_TEMPLATES` holds the
 * graphs. What was missing is the part that turns "the user has these weights on
 * disk and typed this prompt" into a job — which is mostly the unglamorous work
 * of telling Comfy's loader nodes the actual FILENAMES, because a template's
 * placeholder names (`t5xxl.safetensors`) are not what is in anyone's store.
 *
 * ONE JOB AT A TIME, for the same reason the store downloads one repo at a time:
 * these models want the machine's memory to themselves, and two at once finish
 * later than two in sequence while making both progress bars lie.
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import {
  ComfyClient,
  type ComfySupervisorHandle,
  createComfySupervisor,
  type GenJob,
} from '@pi-desktop/gen-service';
import { cacheRoot } from '@pi-desktop/inference';
import { listStore, type StoredModel } from '@pi-desktop/model-store';
import { registerIpcHandlers } from '@pi-desktop/shared';
import type { IpcMain } from 'electron';
import { comfyMainPy, comfyModelPathsYaml } from '../inference/engines-main';
import type { StudioInvokeMap, StudioProgress } from './studio-contract';
import { resolveWorkflow } from './studio-workflow';

type Emit = (channel: 'studio:progress', payload: StudioProgress) => void;

let handle: ComfySupervisorHandle | null = null;
let lastError: string | undefined;
const running = new Map<string, AbortController>();

function comfyVenvPython(): string {
  return path.join(cacheRoot(), 'engines', 'comfyui', '.venv', 'bin', 'python');
}

function engineInstalled(): boolean {
  return existsSync(comfyMainPy()) && existsSync(comfyVenvPython());
}

/**
 * The supervisor, created lazily and reused.
 *
 * ComfyUI takes a long time to come up the first time — it resolves a Torch MPS
 * wheel and imports its whole node graph before `/system_stats` answers — so
 * starting it per job would put that on the clock of every generation. Memoized
 * here; the supervisor's own `resolveOrigin` memoizes the start beneath it.
 */
function supervisor(): ComfySupervisorHandle {
  handle ??= createComfySupervisor({
    pythonPath: comfyVenvPython(),
    mainPy: comfyMainPy(),
    ...(existsSync(comfyModelPathsYaml()) ? { extraModelPathsYaml: comfyModelPathsYaml() } : {}),
  });
  return handle;
}

async function outputDir(jobId: string): Promise<string> {
  const dir = path.join(cacheRoot(), 'studio', jobId);
  await mkdir(dir, { recursive: true });
  return dir;
}

export function registerStudioIpc(
  ipcMain: IpcMain,
  allowSender: (event: unknown) => boolean,
  emit: Emit,
): void {
  registerIpcHandlers<StudioInvokeMap>(
    ipcMain,
    {
      'studio:status': async () => ({
        engineInstalled: engineInstalled(),
        engineRunning: handle?.supervisor.running === true,
        ...(lastError === undefined ? {} : { error: lastError }),
      }),

      'studio:generate': async (req) => {
        if (!engineInstalled()) {
          return {
            ok: false,
            error: 'ComfyUI is not installed — install it in Settings › Engines',
          };
        }
        if (running.size > 0) return { ok: false, error: 'a generation is already running' };

        const stored: readonly StoredModel[] = await listStore();
        const model = stored.find((m) => m.id === req.modelId || m.repo === req.modelId);
        if (model === undefined) return { ok: false, error: `${req.modelId} is not downloaded` };

        const resolved = resolveWorkflow(model, req.kind, stored);
        if (resolved === undefined) {
          // Said plainly rather than failing inside Comfy five minutes later:
          // the graph for this family has not been written yet.
          return {
            ok: false,
            error: `No ${req.kind} workflow for ${model.name} yet — the studio can run LTX video and FLUX images so far.`,
          };
        }

        const jobId = randomUUID();
        const controller = new AbortController();
        running.set(jobId, controller);
        emit('studio:progress', { jobId, phase: 'starting' });

        void (async () => {
          try {
            const dir = await outputDir(jobId);
            const job: GenJob = {
              id: jobId,
              modality: req.kind,
              backend: 'comfyui',
              outputDir: dir,
              comfy: {
                prompt: req.prompt,
                modelId: model.id,
                workflowTemplate: resolved.template,
                inputs: {
                  ...resolved.loaderInputs,
                  prompt: req.prompt,
                  negativePrompt: '',
                  width: req.width ?? 512,
                  height: req.height ?? 512,
                  steps: req.steps ?? 8,
                  ...(req.kind === 'video' ? { length: req.frames ?? 49 } : {}),
                },
                seeds: [req.seed ?? Math.floor(Math.random() * 2 ** 31)],
              },
            };
            const client = new ComfyClient({ resolveOrigin: supervisor().resolveOrigin });
            const outputs = await client.run(job, {
              signal: controller.signal,
              onEvent: (event) => {
                if (event.event !== 'progress') return;
                emit('studio:progress', {
                  jobId,
                  phase: 'running',
                  // The stream counts STEPS; the bar wants a fraction, and a
                  // total of zero (a graph that never reported one) must not
                  // become a divide-by-zero NaN on screen.
                  ...(event.total > 0 ? { fraction: event.step / event.total } : {}),
                });
              },
            });
            emit('studio:progress', {
              jobId,
              phase: 'done',
              outputs: outputs.map((o) => o.outputPath),
            });
          } catch (err) {
            lastError = err instanceof Error ? err.message : String(err);
            emit('studio:progress', {
              jobId,
              phase: controller.signal.aborted ? 'done' : 'error',
              ...(controller.signal.aborted ? {} : { error: lastError }),
            });
          } finally {
            running.delete(jobId);
          }
        })();

        return { ok: true, jobId };
      },

      'studio:cancel': async (req) => {
        const controller = running.get(req.jobId);
        if (controller === undefined) return { ok: false };
        controller.abort();
        return { ok: true };
      },
    },
    { allowSender },
  );
}

/** Stop the ComfyUI server on quit — it is a Python process holding a model. */
export function disposeStudio(): void {
  void handle?.supervisor.dispose();
  handle = null;
}
