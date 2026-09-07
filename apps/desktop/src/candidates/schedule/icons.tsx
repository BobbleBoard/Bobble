/**
 * The few glyphs the schedule needs that the shared set does not have, drawn in
 * the same 16-box / 1.5-stroke / `.pd-icon` recipe as packages/ui icons.tsx so
 * they take the app's stroke token and sit on the same baseline. If a
 * candidate ships, these move to the shared set.
 */
import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement> & { size?: number };

function G({ size = 16, className, children, ...rest }: P) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className === undefined ? 'pd-icon' : `pd-icon ${className}`}
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

export function IconPlay(p: P) {
  return (
    <G {...p}>
      <path d="M5 3.5v9l7.5-4.5z" />
    </G>
  );
}

export function IconPause(p: P) {
  return (
    <G {...p}>
      <path d="M5.5 3.5v9M10.5 3.5v9" />
    </G>
  );
}

export function IconSun(p: P) {
  return (
    <G {...p}>
      <circle cx="8" cy="8" r="2.6" />
      <path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1" />
    </G>
  );
}

export function IconMoon(p: P) {
  return (
    <G {...p}>
      <path d="M13 9.6A5.5 5.5 0 0 1 6.4 3a5.5 5.5 0 1 0 6.6 6.6z" />
    </G>
  );
}

export function IconCalendar(p: P) {
  return (
    <G {...p}>
      <rect x="2.5" y="3.5" width="11" height="10" rx="2" />
      <path d="M2.5 6.75h11M5.5 2v2.5M10.5 2v2.5" />
    </G>
  );
}

export function IconMail(p: P) {
  return (
    <G {...p}>
      <rect x="2" y="3.5" width="12" height="9" rx="2" />
      <path d="M2.5 5l5.5 4 5.5-4" />
    </G>
  );
}

export function IconBell(p: P) {
  return (
    <G {...p}>
      <path d="M4 11V7.5a4 4 0 0 1 8 0V11l1 1.5H3z" />
      <path d="M6.6 14a1.5 1.5 0 0 0 2.8 0" />
    </G>
  );
}

export function IconCheckCircle(p: P) {
  return (
    <G {...p}>
      <circle cx="8" cy="8" r="5.75" />
      <path d="M5.5 8.2l1.7 1.7 3.3-3.6" />
    </G>
  );
}

export function IconAlert(p: P) {
  return (
    <G {...p}>
      <circle cx="8" cy="8" r="5.75" />
      <path d="M8 5v3.4M8 10.9v.1" />
    </G>
  );
}

export function IconRepeat(p: P) {
  return (
    <G {...p}>
      <path d="M3 6.5V6a2.5 2.5 0 0 1 2.5-2.5H12" />
      <path d="M10.2 1.8L12 3.5l-1.8 1.7" />
      <path d="M13 9.5v.5a2.5 2.5 0 0 1-2.5 2.5H4" />
      <path d="M5.8 14.2L4 12.5l1.8-1.7" />
    </G>
  );
}

export function IconTimer(p: P) {
  return (
    <G {...p}>
      <circle cx="8" cy="9" r="5" />
      <path d="M8 6.5V9l1.8 1.2M6.5 1.75h3M8 1.75V4" />
    </G>
  );
}

export function IconHand(p: P) {
  return (
    <G {...p}>
      <path d="M5 8.5V4.2a1 1 0 0 1 2 0V8M7 4V3a1 1 0 0 1 2 0v5M9 3.8a1 1 0 0 1 2 0V8M11 5.5a1 1 0 0 1 2 0v3.5A4.5 4.5 0 0 1 8.5 13.5h-.6a3.9 3.9 0 0 1-3.2-1.7L2.9 9.2a1 1 0 0 1 1.6-1.2L5 9" />
    </G>
  );
}

export function IconArrowRight(p: P) {
  return (
    <G {...p}>
      <path d="M3 8h10M9 4l4 4-4 4" />
    </G>
  );
}

export function IconBolt(p: P) {
  return (
    <G {...p}>
      <path d="M8.8 1.8L3.5 9h4l-.6 5.2L12.5 7h-4z" />
    </G>
  );
}

export function IconChip(p: P) {
  return (
    <G {...p}>
      <rect x="4" y="4" width="8" height="8" rx="1.5" />
      <rect x="6.25" y="6.25" width="3.5" height="3.5" rx="0.5" />
      <path d="M6 1.5V4M10 1.5V4M6 12v2.5M10 12v2.5M1.5 6H4M1.5 10H4M12 6h2.5M12 10h2.5" />
    </G>
  );
}

export function IconDownload(p: P) {
  return (
    <G {...p}>
      <path d="M8 2.5v8M4.8 7.4L8 10.6l3.2-3.2M3 13h10" />
    </G>
  );
}
