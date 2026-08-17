/**
 * The card fetcher's NAMESPACE, which is the part that broke.
 *
 * A dataset's README lives at huggingface.co/datasets/<id>; the model path
 * answers 401 for it, and the pane rendered that as "HTTP 401" over a public
 * dataset whose card loads fine. The bug survived a first fix because there
 * were two `modelCardHandlers` — the exported one here (dead) and a live copy
 * in llm-main.ts — so threading `kind` through this file changed nothing.
 *
 * These assert the URL, since that is the whole decision.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchModelCard } from './modelcard-main';

const urls: string[] = [];

function stubFetch(body: string, status = 200) {
  vi.stubGlobal('fetch', (url: string) => {
    urls.push(String(url));
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      statusText: '',
      text: () => Promise.resolve(body),
    } as Response);
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  urls.length = 0;
});

describe('the card namespace', () => {
  it('asks the datasets path for a dataset', async () => {
    stubFetch('# Wikitext\n\nA language modelling dataset.');
    await fetchModelCard('Salesforce/wikitext-ns1', 'dataset');
    expect(urls[0]).toBe(
      'https://huggingface.co/datasets/Salesforce/wikitext-ns1/raw/main/README.md',
    );
  });

  it('asks the model path for a model, and defaults to it', async () => {
    stubFetch('# A model');
    await fetchModelCard('unsloth/gemma-ns2');
    expect(urls[0]).toBe('https://huggingface.co/unsloth/gemma-ns2/raw/main/README.md');
  });

  it('caches per NAMESPACE, because the same id exists as both', async () => {
    // `wikitext` is a dataset and also the name of model repos. A cache keyed on
    // the id alone would serve one repo's card for the other.
    stubFetch('# dataset card');
    await fetchModelCard('org/collide', 'dataset');
    stubFetch('# model card');
    const asModel = await fetchModelCard('org/collide', 'model');
    expect(asModel.markdown).toContain('model card');
  });

  it('names the right noun when there is no card', async () => {
    stubFetch('', 404);
    const res = await fetchModelCard('org/no-card-here', 'dataset');
    expect(res.error).toBe('This dataset has no card.');
  });

  it('points relative images at the dataset repo, not the model one', async () => {
    stubFetch('![chart](./assets/plot.png)');
    const res = await fetchModelCard('org/imgs-ns', 'dataset');
    expect(res.markdown).toContain(
      'https://huggingface.co/datasets/org/imgs-ns/resolve/main/assets/plot.png',
    );
  });
});
