/**
 * The app's own mark, for the sidebar's top-left identity row.
 *
 * the user: "put text that says <app icon those three squares in the app icon>
 * Bobble, with the app icon in the top left above the search chats bar below
 * the traffic light buttons."
 *
 * Drawn inline rather than loaded from build/icon.png so it is crisp at 20px,
 * re-themes with the app, and costs no request — the icon file is a 1024px
 * raster meant for the Dock.
 *
 * NO PLATE, because the Dock icon no longer has one (the user: "the app dock image
 * shouldn't be there just the three squares"). The whole point of this mark is
 * being the shape people recognise from their Dock, so the two have to agree;
 * the proportions are build/icon.svg's 400px tiles inset 88px in a 1024 canvas,
 * scaled to this 32 viewBox.
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
      <rect x="16.75" y="2.75" width="12.5" height="12.5" rx="3.5" fill="#10BDBD" />
      <rect x="2.75" y="16.75" width="12.5" height="12.5" rx="3.5" fill="#FBC52B" />
      <rect x="16.75" y="16.75" width="12.5" height="12.5" rx="3.5" fill="#F73E9C" />
    </svg>
  );
}
