/**
 * @pi-desktop/design-kit — Validated palettes, type scales and brand kits as token data, read by charts, decks, pages, motion and the studio and Ming presets.
 *
 * One design kit for every visual surface (PLAN.md F10). Kits are data
 * (./kits/*.json), validated here (contrast, colour-blind separation, no
 * purple — the same checks the chart looks clear); consumers read tokens and
 * never invent their own styles (deliverables/research/visual-quality.md §4).
 * Python reads the same tokens through `tools/office-gen/design_tokens.json`
 * (./export.ts). A project's own brand — from a picture or its `brand.md` —
 * is a kit too (./brand.ts).
 *
 * Owned by lane VQ (vq-kit); filled by VQ-04.
 */
export {
  type BrandFile,
  type BrandResult,
  type BrandSpec,
  dePurple,
  fitContrast,
  kitFromBrand,
  kitFromPixels,
  mixHex,
  parseBrandMd,
  readFrontmatter,
} from './brand.ts';
export {
  type DesignTokensFile,
  type DiagramTheme,
  diagramTheme,
  exportTokens,
  kitCssVars,
  over,
  TOKENS_SCHEMA,
  tokensJson,
} from './export.ts';
export { DEFAULT_KIT_ID, KIT_IDS, KITS, kitById, kitOrDefault } from './kits.ts';
export { BRAND_FILE, loadProjectKit, type ProjectKit } from './project.ts';
export {
  COLOUR_ROLES,
  type ColourRole,
  currentPlatform,
  type FontStacks,
  type Hex,
  KIT_SCHEMA_VERSION,
  type Kit,
  type KitChart,
  type KitColours,
  type KitDiagram,
  type KitImage,
  type KitMode,
  type KitMotion,
  KitShapeError,
  type KitSpace,
  type KitType,
  normalizeKitHex,
  type Platform,
  parseKit,
} from './schema.ts';
export {
  APP_GROUNDS,
  checkColours,
  coloursOf,
  describeIssues,
  isLavender,
  isPurple,
  KIT_GATES,
  type KitIssue,
  type KitReport,
  type KitRule,
  validateKit,
} from './validate.ts';
