import type { Artifact, ArtifactContent } from './model.ts';
import { chartArtifactSvg } from './surfaces/chart-surface.tsx';

const KIND_EXTENSION: Record<string, string> = {
  code: 'txt',
  markdown: 'md',
  html: 'html',
  svg: 'svg',
  // A chart artifact's text is its spec; what leaves the app is the drawing.
  chart: 'svg',
};

const LANGUAGE_EXTENSION: Record<string, string> = {
  javascript: 'js',
  typescript: 'ts',
  jsx: 'jsx',
  tsx: 'tsx',
  python: 'py',
  css: 'css',
  html: 'html',
  markdown: 'md',
  json: 'json',
};

export function artifactMimeType(content: ArtifactContent): string {
  if (content.mimeType) return content.mimeType;
  switch (content.kind) {
    case 'html':
      return 'text/html';
    case 'svg':
    case 'chart':
      return 'image/svg+xml';
    case 'markdown':
      return 'text/markdown';
    default:
      return 'text/plain';
  }
}

export function artifactFilename(artifact: Artifact): string {
  if (artifact.filename) return artifact.filename;
  const base =
    (artifact.title ?? artifact.id ?? 'artifact')
      .replace(/[^\w.-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'artifact';
  if (/\.[a-z0-9]+$/i.test(base)) return base;
  const langKey = artifact.content.language?.toLowerCase();
  const ext =
    (langKey && LANGUAGE_EXTENSION[langKey]) || KIND_EXTENSION[artifact.content.kind] || 'txt';
  return `${base}.${ext}`;
}

/** What a download of this artifact contains: its text, or a chart's drawing. */
export function artifactExportText(content: ArtifactContent): string {
  if (content.kind === 'chart') return chartArtifactSvg(content.text) ?? content.text;
  return content.text;
}

/** Trigger a browser download of the artifact's text. Requires a DOM. */
export function downloadArtifact(artifact: Artifact, doc: Document = document): void {
  const blob = new Blob([artifactExportText(artifact.content)], {
    type: artifactMimeType(artifact.content),
  });
  const url = URL.createObjectURL(blob);
  const anchor = doc.createElement('a');
  anchor.href = url;
  anchor.download = artifactFilename(artifact);
  doc.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
