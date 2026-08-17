/**
 * The app's own mark, for the sidebar's top-left identity row.
 *
 * the user: "put text that says <app icon those three squares in the app icon>
 * Bobble, with the app icon in the top left above the search chats bar below
 * the traffic light buttons."
 *
 * Drawn inline rather than loaded from build/icon.png so it is crisp at 20px,
 * re-themes with the app, and costs no request — the icon file is a 1024px
 * raster meant for the Dock. The geometry mirrors it: a dark squircle with
 * three tiles (teal top-right, amber bottom-left, pink bottom-right), which is
 * the shape people will recognise from their Dock.
 */
export function BobbleMark({ size = 20 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      role="img"
      aria-label="Bobble"
      style={{ display: 'block' }}
    >
      <title>Bobble</title>
      <rect x="0.5" y="0.5" width="31" height="31" rx="8" fill="#26282D" />
      <rect x="17" y="6" width="9" height="9" rx="2.6" fill="#10BDBD" />
      <rect x="6" y="17" width="9" height="9" rx="2.6" fill="#FBC52B" />
      <rect x="17" y="17" width="9" height="9" rx="2.6" fill="#F73E9C" />
    </svg>
  );
}
