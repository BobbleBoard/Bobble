/**
 * Four clickable examples on the opening screen — the app's own answer to "what
 * can you do?", so the question never has to be put to the model.
 *
 * See {@link STARTERS} for why the copy is here and not in a prompt.
 *
 * Clicking FILLS the composer rather than sending. The tester typed immediately
 * on first launch; that instinct is the thing to design around, and a chip that
 * fires a request she has not read yet takes the keyboard away from her at the
 * exact moment she was using it.
 */
import { IconFile, IconImage, IconPencil, IconSearch } from '@pi-desktop/ui';
import type { ComponentType } from 'react';
import { usePiStore } from '../state/pi-slice';
import { STARTERS, type Starter } from './starters';

const ICONS: Record<Starter['icon'], ComponentType<{ size?: number }>> = {
  write: IconPencil,
  search: IconSearch,
  image: IconImage,
  file: IconFile,
};

export function StarterChips(): React.ReactElement {
  return (
    /* A fieldset is the semantic version of "these buttons belong together",
     * so the label is carried by a legend rather than an aria-label a screen
     * reader may or may not honour. */
    <fieldset
      /* ONE ROW, ALWAYS. the user: "the suggestion popups need to be larger and
       * never show two rows of them." No wrap; a chip that runs out of room
       * shortens its label instead of dropping to a second line. */
      className="flex flex-nowrap items-center justify-center gap-2.5 border-0 p-0 max-w-full min-w-0"
      data-testid="starter-chips"
    >
      <legend className="sr-only">Things you can ask for</legend>
      {STARTERS.map((s) => {
        const Icon = ICONS[s.icon];
        return (
          <button
            key={s.label}
            type="button"
            className="pd-starter-chip pd-focusable"
            data-testid={`starter-${s.icon}`}
            title={s.prompt}
            /*
             * A PILL, NOT TYPED TEXT. the user: "add blue pills with icons and X buttons
             * … not just typing them." The model still receives the whole request —
             * the pill's payload IS the prompt — but in the box it is one object
             * that removes with a click.
             */
            onClick={() =>
              usePiStore.setState({
                composerPill: { label: s.pill, payload: s.prompt, icon: s.icon },
              })
            }
          >
            <Icon size={16} />
            <span className="pd-starter-chip-label">{s.label}</span>
          </button>
        );
      })}
    </fieldset>
  );
}
