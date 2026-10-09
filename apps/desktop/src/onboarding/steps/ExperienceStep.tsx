/**
 * Guidance — three levels that set the tutorial flag + the permission mode the
 * agent starts in (see mapExperience). Each title says what it changes; the
 * old ones were about the person ("I know what llama.cpp is"), which left
 * them to guess what picking it would do.
 */
import { IconCompass, IconGauge, IconSpeed } from '@pi-desktop/ui';
import type { ReactNode } from 'react';
import type { ExperienceLevel } from '../onboarding-logic';
import { SelectCard } from '../SelectCard';
import { useOnboardingStore } from '../useOnboarding';

const OPTIONS: Array<{
  value: ExperienceLevel;
  title: string;
  description: string;
  icon: ReactNode;
}> = [
  {
    value: 'new',
    title: 'Show me around',
    description: 'A short tour, and you approve each action before it runs.',
    /* A compass — this card asks to be guided. Its two siblings are a gauge and
       a speedometer, so the trio reads as one scale; a sparkle read as "the
       special one". */
    icon: <IconCompass />,
  },
  {
    value: 'knows-llamacpp',
    title: 'Ask only when it is risky',
    description: 'No tour. Bobble asks before anything risky and runs the rest.',
    icon: <IconGauge />,
  },
  {
    value: 'no-tutorial',
    title: 'Just do it',
    description: 'No tour, no questions. Dial it back anytime in Settings.',
    icon: <IconSpeed />,
  },
];

export function ExperienceStep() {
  const experience = useOnboardingStore((s) => s.experience);
  const setExperience = useOnboardingStore((s) => s.setExperience);

  return (
    <div className="flex flex-col gap-2" role="radiogroup" aria-label="How much Bobble asks">
      {OPTIONS.map((opt) => (
        <SelectCard
          key={opt.value}
          data-testid={`experience-${opt.value}`}
          selected={experience === opt.value}
          onSelect={() => setExperience(opt.value)}
          icon={opt.icon}
          title={opt.title}
          description={opt.description}
        />
      ))}
    </div>
  );
}
