/**
 * WHAT KIND OF FILE IS THIS — as a colour and a glyph, not a word.
 *
 * The user, on the presented-file cards: "these file cards need to have more color
 * and unique icons for file types, not just the generic and not anything that
 * just has the generic with 'pptx' under it."
 *
 * A generic page glyph with "PPTX" beneath it says the same thing twice, both
 * times in text. A person tells a deck from a spreadsheet from a photo by
 * colour and shape before reading anything — the way Finder, Slack and every
 * mail client draw attachments — so each family gets its own tile colour and
 * its own mark. No purple anywhere (the user's brief for the whole UI).
 *
 * Pure: a path in, an identity out. Both the present card and anything else
 * that draws a file read from here so two surfaces cannot disagree.
 */

export type FileFamily =
  | 'slides'
  | 'document'
  | 'sheet'
  | 'pdf'
  | 'image'
  | 'vector'
  | 'video'
  | 'audio'
  | 'page'
  | 'code'
  | 'text'
  | 'model3d'
  | 'archive'
  | 'folder'
  | 'file';

export interface FileType {
  readonly family: FileFamily;
  /** The word on the card's second line: "Slides · PPTX". */
  readonly label: string;
  /** The tile colour — the glyph is white on it. */
  readonly color: string;
}

const FAMILY: Record<FileFamily, { label: string; color: string }> = {
  slides: { label: 'Slides', color: '#d2461f' },
  document: { label: 'Document', color: '#2563eb' },
  sheet: { label: 'Spreadsheet', color: '#16a34a' },
  pdf: { label: 'PDF', color: '#b91c1c' },
  image: { label: 'Image', color: '#0891b2' },
  vector: { label: 'Vector', color: '#0d9488' },
  video: { label: 'Video', color: '#ea580c' },
  audio: { label: 'Audio', color: '#ff2d55' },
  page: { label: 'Page', color: '#f59e0b' },
  code: { label: 'Code', color: '#475569' },
  text: { label: 'Text', color: '#64748b' },
  model3d: { label: '3D model', color: '#0284c7' },
  archive: { label: 'Archive', color: '#78716c' },
  folder: { label: 'Folder', color: '#eab308' },
  file: { label: 'File', color: '#6b7280' },
};

const BY_EXT: Record<string, FileFamily> = {
  pptx: 'slides',
  ppt: 'slides',
  key: 'slides',
  odp: 'slides',
  docx: 'document',
  doc: 'document',
  odt: 'document',
  rtf: 'document',
  pages: 'document',
  xlsx: 'sheet',
  xlsm: 'sheet',
  xls: 'sheet',
  csv: 'sheet',
  tsv: 'sheet',
  numbers: 'sheet',
  ods: 'sheet',
  pdf: 'pdf',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  bmp: 'image',
  tif: 'image',
  tiff: 'image',
  heic: 'image',
  avif: 'image',
  svg: 'vector',
  mp4: 'video',
  mov: 'video',
  webm: 'video',
  mkv: 'video',
  avi: 'video',
  m4v: 'video',
  mp3: 'audio',
  wav: 'audio',
  flac: 'audio',
  ogg: 'audio',
  m4a: 'audio',
  aac: 'audio',
  aiff: 'audio',
  html: 'page',
  htm: 'page',
  py: 'code',
  ts: 'code',
  tsx: 'code',
  js: 'code',
  jsx: 'code',
  mjs: 'code',
  cjs: 'code',
  json: 'code',
  yaml: 'code',
  yml: 'code',
  toml: 'code',
  css: 'code',
  scss: 'code',
  sh: 'code',
  zsh: 'code',
  rb: 'code',
  go: 'code',
  rs: 'code',
  c: 'code',
  h: 'code',
  cpp: 'code',
  java: 'code',
  swift: 'code',
  kt: 'code',
  gd: 'code',
  sql: 'code',
  md: 'text',
  markdown: 'text',
  txt: 'text',
  log: 'text',
  glb: 'model3d',
  gltf: 'model3d',
  obj: 'model3d',
  stl: 'model3d',
  fbx: 'model3d',
  ply: 'model3d',
  usdz: 'model3d',
  zip: 'archive',
  tar: 'archive',
  gz: 'archive',
  tgz: 'archive',
  '7z': 'archive',
  rar: 'archive',
  dmg: 'archive',
};

/** Lower-cased extension without the dot, or '' when the name has none. */
export function extensionOf(path: string): string {
  const base = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/** The identity of a path. A name with no extension is a folder — a project. */
export function fileTypeOf(path: string, opts: { folder?: boolean } = {}): FileType {
  const ext = extensionOf(path);
  const family: FileFamily =
    opts.folder === true || ext === '' ? 'folder' : (BY_EXT[ext] ?? 'file');
  return { family, ...FAMILY[family] };
}
