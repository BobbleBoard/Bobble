/**
 * @pi-desktop/inference — electron-free llama.cpp backend: binary manager, GGUF
 * catalog, hardware detection, model downloader, llama-server supervisor, and
 * the pi models.json writer. Consumed by the desktop app's inference-supervisor
 * utility process (wired in a later workstream).
 */
export const packageName = '@pi-desktop/inference';

export * from './accelerator.js';
export * from './calibrate.js';
export * from './catalog.js';
export * from './chat-template.js';
export * from './context-cap.js';
export * from './download.js';
export * from './engine-flags.js';
export * from './engine-launch.js';
export * from './engine-select.js';
export * from './gguf-header.js';
export * from './guardian.js';
export * from './hardware.js';
export * from './hf-search.js';
export * from './llamacpp-manager.js';
export * from './llamacpp-manifest.js';
export * from './llamacpp-source-build.js';
export * from './llamacpp-variants.js';
export * from './mlx-manager.js';
export * from './mmproj.js';
export * from './model-downloader.js';
export * from './models-json.js';
export * from './paths.js';
export * from './perf-args.js';
export * from './portable-knobs.js';
export * from './power-manager.js';
export * from './power-policy.js';
export * from './pressure.js';
export * from './reasoning-budget.js';
export * from './recommender.js';
export * from './supervisor.js';
export * from './uv-run.js';
export * from './vision-launch.js';
export * from './watchdog.js';
