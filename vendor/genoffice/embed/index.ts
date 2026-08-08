/**
 * The only surface Bobble's main process consumes from the vendored tree.
 *
 * Upstream has no installable main-process library — their own shell imports
 * `docs-main` by relative path and compiles it into its own bundle. This file
 * plays that role for us: one entry, bundled to CJS by scripts/build-genoffice.sh,
 * requireable from apps/desktop/electron.
 *
 * Deliberately NOT re-exported:
 *
 *   registerAiIpc / registerSheetsAiIpc / registerSlidesOnlyAiIpc
 *       Their AI dock is Genspark-account-bound and Bobble's own chat is the
 *       chat. Never registering it is the supported way to omit it — upstream's
 *       own shell passes includeAiHandlers:false for sheets.
 *
 *   registerProjectIpc
 *       Registers `project:*`, which Bobble already owns. The vendoring script
 *       prefixes their channels `go:` so the two cannot collide, but their
 *       project store is a separate concept from ours and wiring both would
 *       give a document two competing notions of which project it belongs to.
 *
 *   registerHomeIpc / registerTabsIpc
 *       Upstream's start screen and tab strip. Bobble's canvas owns both.
 */
export {
  configureDocsRuntime,
  registerDocsIpc,
  createDocsView,
  teardownDocsRenderer,
  setDocsShellWindow,
  requestDocsClose,
  docsQueryDirty,
} from '../apps/docs/src/main/docs-main';

export {
  configureSheetsRuntime,
  registerSheetsIpc,
  createSheetsView,
} from '../apps/sheets/src/main/sheets-main';

export { configureSlidesRuntime, createSlidesView } from '../apps/slides/src/main/slides-main';

export { configurePdfRuntime, createPdfView } from '../apps/pdf/src/main/pdf-main';

export {
  configureMarkdownRuntime,
  createMarkdownView,
} from '../apps/markdown/src/main/markdown-main';
