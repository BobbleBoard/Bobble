/**
 * SPECULATIVE DECODING, per model.
 *
 * the user: "a tab for speculative, where we should have a way to allow the user
 * to select any model downloaded (w/ search bar) or search hf and quick
 * download or put a path to a model on their computer or drag and drop a file
 * to be a draft model, all the draft settings, and then maybe a bar with
 * options to select MTP, Eagle-3, Dflash, Dflash2, Dspark, Custom … mtp eagle
 * 3 dflash and dspark would be official and handled by us, so only show models
 * that are supported and we have drafters picked out for already".
 *
 * The bar offers a method only when the running model has that head or a
 * catalogued drafter (a missing drafter gets a Fetch button, not a launch that
 * fails); Custom is always there and takes the user's own GGUF from any of the
 * four routes. Auto means "what calibration chose, else the catalogue's
 * default". Every `--spec-*` / draft flag of the engine follows below, from
 * the engine's own help.
 */
import { MANAGED_LLAMA_FLAGS } from '@pi-desktop/inference/engine-flags';
import { useEffect, useMemo, useState } from 'react';
import type {
  HfGgufFileDTO,
  HfModelHitDTO,
  LlmCatalogEntry,
  LlmStatus,
} from '../../../electron/ipc-contract';
import type {
  EngineFlagValue,
  ModelSpecChoice,
} from '../../../electron/settings/settings-contract';
import { useHfStore } from '../../state/hf-store';
import { type EngineFlagsView, useLlmStore } from '../../state/llm-store';
import {
  type FlagValues,
  methodAvailability,
  runningValue,
  SPEC_METHODS,
} from './engine-settings-logic';
import { FlagRow, type FlagSpec, type PathSource } from './FlagRow';

type LocalGguf = { path: string; name: string; bytes: number; modelId: string; kind: string };

function gb(n: number): string {
  return n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} GB` : `${Math.round(n / 1024 ** 2)} MB`;
}

const SPEC_TYPES = ['draft-simple', 'draft-eagle3', 'draft-dflash', 'draft-dspark', 'draft-mtp'];

/** The Custom picker: downloaded GGUFs with search, HF search + quick download, a path, or a drop. */
function CustomDraftPicker({
  choice,
  onChoice,
  catalog,
}: {
  choice: ModelSpecChoice;
  onChoice: (next: ModelSpecChoice) => void;
  catalog: LlmCatalogEntry[];
}) {
  const [tab, setTab] = useState<'downloaded' | 'hf' | 'path'>('downloaded');
  const [local, setLocal] = useState<LocalGguf[]>([]);
  const [query, setQuery] = useState('');
  const [pathText, setPathText] = useState(choice.draftPath ?? '');
  const [dragging, setDragging] = useState(false);
  const hf = useHfStore();

  useEffect(() => {
    void window.piDesktop
      .invoke('llm:list-local-ggufs', undefined)
      .then((r) => setLocal(r.files))
      .catch(() => setLocal([]));
  }, []);

  const shown = local.filter((f) => {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return true;
    const model = catalog.find((c) => c.id === f.modelId)?.displayName ?? f.modelId;
    return f.name.toLowerCase().includes(q) || model.toLowerCase().includes(q);
  });
  const pick = (draftPath: string) =>
    onChoice({ method: 'custom', draftPath, specType: choice.specType ?? 'draft-simple' });

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the drop target is the whole picker; every route inside it has its own control
    <div
      className={`pd-draft-picker${dragging ? ' pd-draft-picker--drop' : ''}`}
      data-testid="custom-draft-picker"
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        const file = e.dataTransfer.files[0];
        if (file === undefined) return;
        const p = window.piDesktop.pathForFile(file);
        if (p.length > 0) {
          setPathText(p);
          pick(p);
        }
      }}
    >
      <div className="pd-draft-current" data-testid="custom-draft-current">
        {choice.draftPath !== undefined ? (
          <>
            <span className="pd-draft-current-label">Draft model</span>
            <code className="pd-draft-current-path">{choice.draftPath}</code>
          </>
        ) : (
          <span className="pd-engine-row-sub">
            No draft picked yet — choose a downloaded GGUF, search Hugging Face, type a path, or
            drop a .gguf here.
          </span>
        )}
      </div>
      <div className="pd-draft-tabs">
        {(
          [
            ['downloaded', 'Downloaded'],
            ['hf', 'Hugging Face'],
            ['path', 'Path'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={`pd-draft-tab${tab === id ? ' pd-draft-tab--on' : ''}`}
            onClick={() => setTab(id)}
            data-testid={`custom-draft-tab-${id}`}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'downloaded' ? (
        <div className="pd-draft-list">
          <input
            type="search"
            className="pd-input pd-focusable"
            placeholder="Search downloaded GGUFs…"
            aria-label="Search downloaded models"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="pd-draft-rows">
            {shown.length === 0 ? (
              <p className="pd-engine-row-sub">Nothing downloaded matches.</p>
            ) : (
              shown.map((f) => (
                <button
                  key={f.path}
                  type="button"
                  className={`pd-draft-row${choice.draftPath === f.path ? ' pd-draft-row--on' : ''}`}
                  onClick={() => pick(f.path)}
                  data-testid={`custom-draft-local-${f.name}`}
                >
                  <span className="pd-draft-row-name">{f.name}</span>
                  <span className="pd-draft-row-sub">
                    {catalog.find((c) => c.id === f.modelId)?.displayName ?? f.modelId} · {f.kind} ·{' '}
                    {gb(f.bytes)}
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      ) : tab === 'hf' ? (
        <div className="pd-draft-list">
          <form
            className="pd-draft-hf-search"
            onSubmit={(e) => {
              e.preventDefault();
              void hf.search({ query, limit: 12 });
            }}
          >
            <input
              type="search"
              className="pd-input pd-focusable"
              placeholder="Search Hugging Face for a draft GGUF (e.g. Qwen3.5-4B-DFlash)…"
              aria-label="Search Hugging Face"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <button type="submit" className="pd-engine-install">
              Search
            </button>
          </form>
          {hf.searchStatus === 'searching' ? <p className="pd-engine-row-sub">Searching…</p> : null}
          {hf.searchError !== null ? (
            <p className="pd-engine-row-sub pd-engine-row-sub--error">{hf.searchError}</p>
          ) : null}
          <div className="pd-draft-rows">
            {hf.results.map((hit: HfModelHitDTO) => (
              <div key={hit.id} className="pd-draft-row pd-draft-row--static">
                <button
                  type="button"
                  className="pd-draft-row-name pd-draft-row-btn"
                  onClick={() => void hf.selectRepo(hit)}
                >
                  {hit.id}
                </button>
                <span className="pd-draft-row-sub">
                  {hit.downloads.toLocaleString()} downloads · {hit.likes} likes
                </span>
                {hf.selected?.id === hit.id ? (
                  <div className="pd-draft-files">
                    {hf.filesStatus === 'loading' ? (
                      <span className="pd-draft-row-sub">listing files…</span>
                    ) : null}
                    {hf.files.map((f: HfGgufFileDTO) => (
                      <button
                        key={f.path}
                        type="button"
                        className="pd-engine-install"
                        onClick={() =>
                          void hf.addAndDownload(hit, f).then(async () => {
                            const r = await window.piDesktop.invoke(
                              'llm:list-local-ggufs',
                              undefined,
                            );
                            setLocal(r.files);
                            const got = r.files.find((x) => x.name === f.path.split('/').pop());
                            if (got !== undefined) pick(got.path);
                          })
                        }
                      >
                        Get {f.path.split('/').pop()}
                        {f.sizeBytes !== undefined ? ` · ${gb(f.sizeBytes)}` : ''}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="pd-draft-list">
          <div className="pd-draft-hf-search">
            <input
              type="text"
              className="pd-input pd-focusable"
              placeholder="/path/to/draft.gguf"
              aria-label="Draft model path"
              value={pathText}
              onChange={(e) => setPathText(e.target.value)}
              onBlur={() => pathText.trim().length > 0 && pick(pathText.trim())}
              data-testid="custom-draft-path"
            />
            <button
              type="button"
              className="pd-engine-install"
              onClick={() =>
                void window.piDesktop.invoke('llm:pick-gguf', undefined).then((r) => {
                  if (r.path !== null) {
                    setPathText(r.path);
                    pick(r.path);
                  }
                })
              }
            >
              Choose…
            </button>
          </div>
          <p className="pd-engine-row-sub">Or drop a .gguf anywhere on this panel.</p>
        </div>
      )}
      <div className="pd-draft-type">
        <span className="pd-flag-key">--spec-type</span>
        <select
          className="pd-input pd-focusable pd-flag-select"
          aria-label="Spec type for the custom draft"
          value={choice.specType ?? 'draft-simple'}
          onChange={(e) => onChoice({ ...choice, method: 'custom', specType: e.target.value })}
          data-testid="custom-draft-spec-type"
        >
          {SPEC_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <span className="pd-engine-row-sub">
          llama.cpp reads DFlash2 and DSpark heads from the file itself; pick the family the draft
          was made for.
        </span>
      </div>
    </div>
  );
}

export function SpeculativeTab({
  entry,
  status,
  choice,
  onChoice,
  help,
  values,
  onFlag,
  onPath,
}: {
  entry: LlmCatalogEntry | undefined;
  status: LlmStatus;
  choice: ModelSpecChoice;
  onChoice: (next: ModelSpecChoice) => void;
  help: EngineFlagsView | null;
  values: FlagValues;
  onFlag: (key: string, value: EngineFlagValue | null) => void;
  onPath: (flag: FlagSpec, source: PathSource) => Promise<string | null>;
}) {
  const catalog = useLlmStore((s) => s.catalog);
  const record = useLlmStore((s) => s.record);
  const downloadModel = useLlmStore((s) => s.downloadModel);
  const download = useLlmStore((s) => s.download);
  const availability = useMemo(
    () =>
      methodAvailability(entry, {
        draftsOnDisk: entry?.draftersOnDisk ?? [],
        specTypes: status.engineSpecTypes ?? [],
      }),
    [entry, status.engineSpecTypes],
  );
  const specFlags = useMemo(
    () => (help?.flags ?? []).filter((f) => f.category === 'Speculative decoding'),
    [help],
  );
  const calibrated = record?.chosen ?? null;
  const fetching = download !== null && entry !== undefined && download.modelId === entry.id;

  return (
    <div className="pd-spec" data-testid="speculative-tab">
      <div className="pd-spec-bar" data-testid="spec-method-bar">
        {SPEC_METHODS.map((m) => {
          const a = availability.find((x) => x.method === m.method);
          const offered = a?.offered === true;
          const on = choice.method === m.method;
          return (
            <button
              key={m.method}
              type="button"
              aria-pressed={on}
              disabled={!offered}
              title={a?.note ?? m.blurb}
              className={`pd-spec-chip${on ? ' pd-spec-chip--on' : ''}`}
              data-testid={`spec-method-${m.method}`}
              data-ready={a?.ready === true ? 'yes' : 'no'}
              onClick={() =>
                onChoice(
                  m.method === 'custom'
                    ? {
                        method: 'custom',
                        draftPath: choice.draftPath,
                        specType: choice.specType ?? 'draft-simple',
                      }
                    : { method: m.method },
                )
              }
            >
              {a?.label ?? m.label}
              {m.method === 'auto' && calibrated !== null ? (
                <span className="pd-spec-chip-sub">
                  calibrated: {calibrated.engine} · {calibrated.spec}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
      <p className="pd-engine-row-sub pd-spec-blurb" data-testid="spec-method-blurb">
        {SPEC_METHODS.find((m) => m.method === choice.method)?.blurb}
        {(() => {
          const a = availability.find((x) => x.method === choice.method);
          return a?.offered && !a.ready ? ` — ${a.note}` : '';
        })()}
      </p>
      {(() => {
        const a = availability.find((x) => x.method === choice.method);
        if (a === undefined || !a.offered || a.ready || entry === undefined) return null;
        return (
          <button
            type="button"
            className="pd-engine-install"
            data-testid="spec-fetch-drafter"
            disabled={fetching}
            onClick={() => void downloadModel(entry.id, status.model?.quant)}
          >
            {fetching ? 'Fetching…' : 'Fetch the drafter now'}
          </button>
        );
      })()}
      {choice.method === 'custom' ? (
        <CustomDraftPicker choice={choice} onChoice={onChoice} catalog={catalog} />
      ) : null}
      <section className="pd-flags-group">
        <h4 className="pd-flags-group-title">Draft settings ({specFlags.length})</h4>
        <div className="pd-flags-list">
          {specFlags.map((f) => (
            <FlagRow
              key={f.key}
              flag={f}
              value={values[f.key]}
              running={runningValue(status, f.aliases)}
              managed={MANAGED_LLAMA_FLAGS[f.key]}
              onChange={(v) => onFlag(f.key, v)}
              onPath={onPath}
            />
          ))}
        </div>
      </section>
    </div>
  );
}
