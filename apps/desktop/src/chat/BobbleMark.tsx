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
 * NO PLATE — deliberately, and NOT in step with the Dock icon, which has its
 * dark squircle back (the user: "restore the dark background to the app icon, (but
 * not to the top left icon, make that one slightly bigger also)").
 *
 * The two therefore differ on purpose. In the Dock an icon needs its own ground
 * to sit on, because it is competing with thirty other apps on an unknown
 * wallpaper. Here the sidebar already IS the ground, so a plate would just be a
 * dark square on a dark panel — the tiles alone read as the mark.
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
