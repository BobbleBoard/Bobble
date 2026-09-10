/**
 * WHAT IS ACTUALLY RUNNING, on hover of the status in the top bar.
 *
 * the user: "hover this pill at the top for a bit of model information, a little
 * popout of the model card, who it's by, a split line the engine being run on
 * (both with logos name quick description and then a Learn more <square with
 * top right arrow>> big blue button for both top and bottom parts."
 *
 * Two halves because they are two different things and people conflate them:
 * the MODEL is the weights and whoever published them, the ENGINE is the thing
 * running those weights on this Mac. A person who has just watched "Starting
 * up" for ten seconds is entitled to know which of the two they were waiting
 * for.
 *
 * Everything here is read from what the app already knows. There is no
 * description field in the catalogue, so the model's line is the facts it does
 * have — quant, context, whether it can see — rather than marketing copy
 * invented for it.
 */

import { OrgAvatar } from '../settings/brand-icons';
import { IconExternal } from '../settings/icons';
import { useLlmStore } from '../state/llm-store';
import { orgOf } from './quick-menu';

/** k/M, so a 262144-token window reads as 256k rather than as a phone number. */
function contextLabel(tokens: number | undefined): string | null {
  if (tokens === undefined || tokens <= 0) return null;
  if (tokens >= 1_000_000) return `${(tokens / 1_048_576).toFixed(1).replace(/\.0$/, '')}M context`;
  return `${Math.round(tokens / 1024)}k context`;
}

function Half({
  logo,
  name,
  by,
  description,
  href,
  testid,
}: {
  logo: React.ReactNode;
  name: string;
  by: string | null;
  description: string;
  href: string;
  testid: string;
}) {
  return (
    <div className="pd-modelcard-half" data-testid={testid}>
      <div className="pd-modelcard-head">
        {logo}
        <div className="pd-modelcard-names">
          <span className="pd-modelcard-name">{name}</span>
          {by === null ? null : <span className="pd-modelcard-by">by {by}</span>}
        </div>
      </div>
      <p className="pd-modelcard-desc">{description}</p>
      {/* A real anchor, not a button that calls out: the app opens external
          links in the user's browser and an anchor is what screen readers and
          right-click both already understand. */}
      <a
        className="pd-btn pd-btn--accent pd-modelcard-cta"
        href={href}
        target="_blank"
        rel="noreferrer"
        data-testid={`${testid}-learn-more`}
      >
        Learn more
        <IconExternal width={14} height={14} />
      </a>
    </div>
  );
}

export function TopBarModelCard() {
  const model = useLlmStore((s) => s.status.model);
  const catalog = useLlmStore((s) => s.catalog);
  const entry = catalog?.find((c) => c.id === model?.id);
  const org = model === null ? '' : orgOf(model.id, entry?.hfRepo);

  const facts = [
    model?.quant,
    contextLabel(model?.contextWindow),
    entry?.vision === true ? 'reads images' : null,
    entry?.license,
  ].filter((x): x is string => typeof x === 'string' && x !== '');

  return (
    <div className="pd-modelcard" data-testid="topbar-model-card" role="note">
      <Half
        logo={<OrgAvatar org={org === '' ? (model?.displayName ?? 'model') : org} size={30} />}
        name={model?.displayName ?? 'No model loaded'}
        by={org === '' ? null : org}
        description={
          facts.length > 0
            ? facts.join(' · ')
            : 'The weights answering your messages. Nothing you type reaches anyone else.'
        }
        href={
          entry?.hfRepo === undefined
            ? 'https://huggingface.co/models'
            : `https://huggingface.co/${entry.hfRepo}`
        }
        testid="modelcard-model"
      />

      {/* The split line the user asked for: two things, not one list. */}
      <div className="pd-modelcard-rule" />

      <Half
        logo={<OrgAvatar org="ggml-org" size={30} />}
        name="llama.cpp"
        by="ggml"
        description="Runs the model on this Mac's own GPU, offline. It is what the wait above is waiting for."
        href="https://github.com/ggml-org/llama.cpp"
        testid="modelcard-engine"
      />
    </div>
  );
}
