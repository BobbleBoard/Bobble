/**
 * How hands-on — one page for the two answers to "how much does Bobble do
 * without asking": the guidance level (tour + permission mode) and computer
 * use (on/off + the apps it may drive). They were two pages; a person decides
 * them together.
 */
import { ComputerUseStep } from './ComputerUseStep';
import { ExperienceStep } from './ExperienceStep';

export function HandsOnStep() {
  return (
    <div className="flex flex-col gap-8" data-testid="onboarding-hands-on">
      <section className="flex flex-col gap-3">
        <h2 className="text-body font-medium text-text-primary">Before it acts</h2>
        <ExperienceStep />
      </section>
      <section>
        <ComputerUseStep gridMaxHeight="min(32vh, 300px)" />
      </section>
    </div>
  );
}
