/**
 * The engine picker of the Advanced panel — the app's own dropdown, not a
 * native <select> (the user: "use the app's custom dropdown styling universally").
 */
import { Select, SelectContent, SelectItem, SelectTrigger } from '@pi-desktop/ui';

export function EngineSelect({
  engine,
  choices,
  runningEngine,
  serverRunning,
  onChange,
  testId,
}: {
  engine: string;
  choices: ReadonlyArray<{ id: string; name: string }>;
  runningEngine: string;
  serverRunning: boolean;
  onChange: (engine: string) => void;
  testId?: string;
}) {
  const label = (id: string): string =>
    `${choices.find((c) => c.id === id)?.name ?? id}${id === runningEngine && serverRunning ? ' · running' : ''}`;
  return (
    <Select value={engine} onValueChange={onChange}>
      <SelectTrigger
        className="pd-btn--sm pd-engine-select"
        aria-label="Engine"
        data-testid={testId}
      >
        {label(engine)}
      </SelectTrigger>
      <SelectContent align="start">
        {choices.map((c) => (
          <SelectItem key={c.id} value={c.id}>
            {label(c.id)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
