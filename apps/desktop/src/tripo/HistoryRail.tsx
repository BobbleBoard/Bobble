/**
 * THE HISTORY RAIL — an asset's versions as a line of stages, on the viewport.
 *
 * The user (2026-09-14), with a mock: "replace history tab with something like
 * shown, embedded not a card in the history area obviously but similar style,
 * hover to preview in viewport what it looked like at that stage, click to go
 * back, and then it can branch." Their drawing: "History" with a chevron, dots
 * joined by a dashed line, one stage name a row, the current one blue with a
 * white core.
 *
 * What it is on top of: every pipeline op adds a VERSION node to the loaded
 * asset (store.ts AssetVersion — a tree, so an op run from an older node is a
 * branch). The rail lists them root-to-leaf. Pointing at one previews it in
 * the viewport (the viewer already honours `previewVersionId`); clicking one
 * makes it the working version, and the next op branches from there — the
 * mechanism the tree was built for, now one hover and one click away instead
 * of a tab with "Use" buttons.
 */
import type { JSX } from 'react';
import { IcChevronUp } from './icons';
import { type AssetVersion, type StudioAsset, type TripoOp, useTripoStore } from './store';

/** A stage's name, in the words of the mock. */
const STAGE_NAME: Record<TripoOp, string> = {
  source: 'Geometry Generation',
  segment: 'Segmentation',
  retopo: 'Low-Poly Generation',
  texture: 'Texture Painting',
  rig: 'Rigging',
  motion: 'Motion',
};

/** Root-to-leaf, depth-first — the same order the tab drew. */
export function orderedVersions(asset: StudioAsset): AssetVersion[] {
  const out: AssetVersion[] = [];
  const walk = (parentId: string | null): void => {
    for (const v of asset.versions.filter((x) => x.parentId === parentId)) {
      out.push(v);
      walk(v.id);
    }
  };
  walk(null);
  for (const v of asset.versions) if (!out.includes(v)) out.push(v);
  return out;
}

export function stageName(version: AssetVersion, asset: StudioAsset): string {
  if (version.op === 'source') {
    return asset.source === 'imported' ? 'Imported model' : STAGE_NAME.source;
  }
  return STAGE_NAME[version.op] ?? version.label;
}

export function HistoryRail(): JSX.Element | null {
  const loadedAssetId = useTripoStore((s) => s.loadedAssetId);
  const assets = useTripoStore((s) => s.assets);
  const previewVersionId = useTripoStore((s) => s.previewVersionId);
  const previewVersion = useTripoStore((s) => s.previewVersion);
  const setCurrentVersion = useTripoStore((s) => s.setCurrentVersion);
  const open = useTripoStore((s) => s.historyOpen);
  const set = useTripoStore((s) => s.set);
  const asset = assets.find((a) => a.id === loadedAssetId);
  if (asset === undefined) return null;
  const rows = orderedVersions(asset);

  return (
    <nav className="tp-history-rail" data-testid="tp-history-rail" data-open={open}>
      <button
        type="button"
        className="tp-history-head"
        data-testid="tp-history-toggle"
        aria-expanded={open}
        onClick={() => set('historyOpen', !open)}
      >
        <span>History</span>
        <IcChevronUp size={13} className="tp-history-caret" />
      </button>
      {open ? (
        <ol className="tp-history-list" onMouseLeave={() => previewVersion(null)}>
          {rows.map((v) => {
            const current = v.id === asset.currentVersionId;
            const previewing = previewVersionId === v.id;
            return (
              <li key={v.id} className="tp-history-item">
                <button
                  type="button"
                  className="tp-history-node"
                  data-testid={`tp-history-${v.id}`}
                  data-current={current}
                  data-previewing={previewing && !current}
                  title={
                    current
                      ? 'The working version'
                      : 'Hover to preview · click to go back to this stage (the next stage branches from here)'
                  }
                  onMouseEnter={() => {
                    if (!current) previewVersion(v.id);
                  }}
                  onFocus={() => {
                    if (!current) previewVersion(v.id);
                  }}
                  onClick={() => {
                    previewVersion(null);
                    if (!current) setCurrentVersion(asset.id, v.id);
                  }}
                >
                  <span className="tp-history-dot" aria-hidden="true" />
                  <span className="tp-history-label">{stageName(v, asset)}</span>
                </button>
              </li>
            );
          })}
        </ol>
      ) : null}
    </nav>
  );
}
