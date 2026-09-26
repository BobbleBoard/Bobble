/**
 * @pi-desktop/gen-tools — a pi extension that gives the model a `generate_image`
 * tool. It generates on-device (Apple-Silicon MLX via mflux) by enqueuing a job
 * over a token-authed socket bridge to the app's JobQueue; progress streams to
 * the canvas and the produced image(s) return to the model.
 *
 * The default export is the zero-config activation Pi Desktop loads via `-e`
 * (add `'gen-tools'` to EXTENSION_PACKAGE_DIRS in apps/desktop/electron/pi/
 * pi-main.ts). It builds the bridge from the env the app injects before spawn
 * (PI_GEN_SOCK / PI_GEN_TOKEN). Loaded outside Pi Desktop (no env) the tool still
 * registers but reports "bridge unavailable", so it is always safe to load.
 */
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { GenBridgeClient } from './gen-bridge-client.js';
import { type GenToolsOptions, registerAudioTools, registerGenTools } from './tools.js';

export * from './gen-bridge-client.js';
export * from './gen-contract.js';
export * from './tools.js';

/** Register the gen tools with an explicit bridge (test / app seam). */
export function registerGenUse(pi: ExtensionAPI, options: GenToolsOptions): void {
  registerGenTools(pi, options);
  registerAudioTools(pi, options);
}

/** pi extension factory (zero-config; reads the bridge socket from env). */
export default function activate(pi: ExtensionAPI): void {
  const bridge = GenBridgeClient.fromEnv();
  /*
   * WHICH TOOLS, not whether to load. The app always loads this extension now;
   * the media tools stay behind the generation experiment, and `generate_svg`
   * appears only once the OmniSVG connector's model is on disk — the app reads
   * the files at pi's spawn and says so here.
   */
  const media = process.env.PI_DESKTOP_GEN_MEDIA === '1';
  // Two engines behind `svg`: OmniSVG draws pictures, VFIG writes figures and edits.
  const svgEngines = {
    omnisvg: process.env.PI_OMNISVG_READY === '1',
    vfig: process.env.PI_VFIG_READY === '1',
  };
  registerGenTools(pi, { bridge, media, svg: svgEngines.omnisvg || svgEngines.vfig, svgEngines });
  if (media) registerAudioTools(pi, { bridge });
}
