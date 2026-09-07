/**
 * The warning mark: a circle with an exclamation in it.
 *
 * the user, on an image attached to a model that cannot read one: "show a yellow
 * circle + ! on images both in chat input and when sent." It is drawn here
 * rather than pulled from the icon set because the set has no filled warning
 * mark, and the badge has to read at 14px over a photograph — which needs the
 * filled disc, not an outline.
 */
export function IconWarning({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      role="img"
      aria-label="Warning"
      focusable="false"
    >
      {/* Named rather than aria-hidden: this mark is sometimes the ONLY thing
          saying an attachment will not be read, and a decorative icon beside no
          text says nothing to a screen reader. */}
      <circle cx="8" cy="8" r="7" fill="currentColor" />
      <path d="M8 4.25v4.4" stroke="var(--pd-bg-base)" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="8" cy="11.35" r="0.95" fill="var(--pd-bg-base)" />
    </svg>
  );
}
