/**
 * THE ICON SET: Hugeicons, one drawing system for the whole app.
 *
 * the user (2026-10-08): "I still like the hugeicons better than drawn". Every
 * icon here is a Hugeicons stroke-rounded drawing (MIT, Copyright (c) 2025
 * Hugeicons, from @hugeicons/core-free-icons, pinned) on the 24-grid, the same
 * family as the Glyph set (glyph.tsx); where an idea already has a glyph (chat,
 * image, video, audio, puzzle, folder, compass) the icon IS that glyph, so one
 * idea is drawn once across the app. The one exception is GitHub, whose mark is
 * the brand's own (simple-icons, CC0) and is filled. Nothing here is drawn by us.
 *
 * Every icon is decorative (aria-hidden); an icon-only control carries its own
 * label. Names say what the icon stands for in the app, so a swap is one line.
 * Thickness and size come from icons.css: `--pd-icon-stroke` is the stroke in
 * screen pixels at any size (1 by default: the user, "I like the 1px stroke 13px
 * text"), `--pd-icon-base` and `--pd-icon-scale` the box.
 */

import Add01Icon from '@hugeicons/core-free-icons/Add01Icon';
import AiBrain01Icon from '@hugeicons/core-free-icons/AiBrain01Icon';
import Alert02Icon from '@hugeicons/core-free-icons/Alert02Icon';
import Analytics01Icon from '@hugeicons/core-free-icons/Analytics01Icon';
import ArrowDown01Icon from '@hugeicons/core-free-icons/ArrowDown01Icon';
import ArrowExpand02Icon from '@hugeicons/core-free-icons/ArrowExpand02Icon';
import ArrowLeft01Icon from '@hugeicons/core-free-icons/ArrowLeft01Icon';
import ArrowRight01Icon from '@hugeicons/core-free-icons/ArrowRight01Icon';
import ArrowUp02Icon from '@hugeicons/core-free-icons/ArrowUp02Icon';
import Attachment01Icon from '@hugeicons/core-free-icons/Attachment01Icon';
import Camera01Icon from '@hugeicons/core-free-icons/Camera01Icon';
import Cancel01Icon from '@hugeicons/core-free-icons/Cancel01Icon';
import CheckmarkCircle02Icon from '@hugeicons/core-free-icons/CheckmarkCircle02Icon';
import Clock01Icon from '@hugeicons/core-free-icons/Clock01Icon';
import CommandLineIcon from '@hugeicons/core-free-icons/CommandLineIcon';
import Copy01Icon from '@hugeicons/core-free-icons/Copy01Icon';
import CpuIcon from '@hugeicons/core-free-icons/CpuIcon';
import CubeIcon from '@hugeicons/core-free-icons/CubeIcon';
import Cursor01Icon from '@hugeicons/core-free-icons/Cursor01Icon';
import DashboardSpeed02Icon from '@hugeicons/core-free-icons/DashboardSpeed02Icon';
import DashboardSquare01Icon from '@hugeicons/core-free-icons/DashboardSquare01Icon';
import Delete02Icon from '@hugeicons/core-free-icons/Delete02Icon';
import Download01Icon from '@hugeicons/core-free-icons/Download01Icon';
import File02Icon from '@hugeicons/core-free-icons/File02Icon';
import FireIcon from '@hugeicons/core-free-icons/FireIcon';
import FlashIcon from '@hugeicons/core-free-icons/FlashIcon';
import FolderAddIcon from '@hugeicons/core-free-icons/FolderAddIcon';
import GitCompareIcon from '@hugeicons/core-free-icons/GitCompareIcon';
import Globe02Icon from '@hugeicons/core-free-icons/Globe02Icon';
import HierarchySquare02Icon from '@hugeicons/core-free-icons/HierarchySquare02Icon';
import InformationCircleIcon from '@hugeicons/core-free-icons/InformationCircleIcon';
import Key01Icon from '@hugeicons/core-free-icons/Key01Icon';
import KeyboardIcon from '@hugeicons/core-free-icons/KeyboardIcon';
import LayoutLeftIcon from '@hugeicons/core-free-icons/LayoutLeftIcon';
import LayoutRightIcon from '@hugeicons/core-free-icons/LayoutRightIcon';
import LinkSquare02Icon from '@hugeicons/core-free-icons/LinkSquare02Icon';
import Menu01Icon from '@hugeicons/core-free-icons/Menu01Icon';
import Mic01Icon from '@hugeicons/core-free-icons/Mic01Icon';
import Moon02Icon from '@hugeicons/core-free-icons/Moon02Icon';
import MoreHorizontalIcon from '@hugeicons/core-free-icons/MoreHorizontalIcon';
import MusicNote03Icon from '@hugeicons/core-free-icons/MusicNote03Icon';
import PanelRightIcon from '@hugeicons/core-free-icons/PanelRightIcon';
import PauseIcon from '@hugeicons/core-free-icons/PauseIcon';
import PencilEdit01Icon from '@hugeicons/core-free-icons/PencilEdit01Icon';
import PieChartIcon from '@hugeicons/core-free-icons/PieChartIcon';
import Pin02Icon from '@hugeicons/core-free-icons/Pin02Icon';
import PlayIcon from '@hugeicons/core-free-icons/PlayIcon';
import Plug01Icon from '@hugeicons/core-free-icons/Plug01Icon';
import Refresh01Icon from '@hugeicons/core-free-icons/Refresh01Icon';
import Search01Icon from '@hugeicons/core-free-icons/Search01Icon';
import SentIcon from '@hugeicons/core-free-icons/SentIcon';
import Settings01Icon from '@hugeicons/core-free-icons/Settings01Icon';
import Share03Icon from '@hugeicons/core-free-icons/Share03Icon';
import Shield01Icon from '@hugeicons/core-free-icons/Shield01Icon';
import SidebarLeftIcon from '@hugeicons/core-free-icons/SidebarLeftIcon';
import SlidersHorizontalIcon from '@hugeicons/core-free-icons/SlidersHorizontalIcon';
import SourceCodeIcon from '@hugeicons/core-free-icons/SourceCodeIcon';
import SparkleIcon from '@hugeicons/core-free-icons/SparkleIcon';
import SparklesIcon from '@hugeicons/core-free-icons/SparklesIcon';
import SquareLock02Icon from '@hugeicons/core-free-icons/SquareLock02Icon';
import StarIcon from '@hugeicons/core-free-icons/StarIcon';
import StopIcon from '@hugeicons/core-free-icons/StopIcon';
import Sun03Icon from '@hugeicons/core-free-icons/Sun03Icon';
import TaskDone01Icon from '@hugeicons/core-free-icons/TaskDone01Icon';
import ThumbsDownIcon from '@hugeicons/core-free-icons/ThumbsDownIcon';
import ThumbsUpIcon from '@hugeicons/core-free-icons/ThumbsUpIcon';
import Tick02Icon from '@hugeicons/core-free-icons/Tick02Icon';
import Video01Icon from '@hugeicons/core-free-icons/Video01Icon';
import ViewIcon from '@hugeicons/core-free-icons/ViewIcon';
import Wrench01Icon from '@hugeicons/core-free-icons/Wrench01Icon';
import { clsx } from 'clsx';
import { type CSSProperties, createElement, type ReactNode, type SVGProps } from 'react';
import { GLYPHS, type GlyphName } from './glyph';

export type IconProps = SVGProps<SVGSVGElement> & { size?: number };

/**
 * The size an icon was asked for, as a CSS variable on the element: icons.css
 * draws `.pd-icon` at `--pd-icon-base × --pd-icon-scale` (Settings › Interface
 * › Size), so one global scale resizes every icon without touching a `size`.
 */
export function iconBaseStyle(size: number, style?: CSSProperties): CSSProperties {
  return { ...style, '--pd-icon-base': size } as CSSProperties;
}

/** A Hugeicons drawing: `[tag, attributes]` pairs on the 24-grid. */
type HugeiconData = readonly (readonly [string, { readonly [key: string]: string | number }])[];

function Svg24({
  size = 16,
  className,
  style,
  children,
  ...rest
}: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      // `.pd-icon` sets `stroke-width: var(--pd-icon-stroke)`; CSS beats this
      // presentation attribute, so the token wins when styles are loaded and
      // this stays a no-CSS fallback (Hugeicons' own 1.5 on the 24-grid).
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={clsx('pd-icon', className)}
      style={iconBaseStyle(size, style)}
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

/**
 * Draw one Hugeicons icon. Each element's own `strokeWidth` is dropped: a
 * presentation attribute on the path would beat the stroke the svg inherits
 * from `.pd-icon`, and the one thickness token is the point. A `stroke` of
 * currentColor is dropped too (the svg sets it); any other paint is kept.
 */
function Huge({ icon, ...props }: IconProps & { icon: HugeiconData }) {
  return (
    <Svg24 {...props}>
      {icon.map(([tag, attrs], i) => {
        const { key, strokeWidth: _w, stroke, ...rest } = attrs;
        return createElement(tag, {
          key: key ?? i,
          ...rest,
          ...(stroke !== undefined && stroke !== 'currentColor' ? { stroke } : {}),
        });
      })}
    </Svg24>
  );
}

/** The glyph for an idea the Glyph set already draws, at icon sizes. */
function FromGlyph({ glyph, ...props }: IconProps & { glyph: GlyphName }) {
  return (
    <Svg24 {...props}>
      {GLYPHS[glyph].map((p) => (
        <path
          key={p.d}
          d={p.d}
          {...('cap' in p && p.cap === 'butt' ? { strokeLinecap: 'butt' as const } : {})}
          {...('join' in p && p.join === 'miter' ? { strokeLinejoin: 'miter' as const } : {})}
          {...('fill' in p && p.fill ? { fill: 'currentColor', stroke: 'none' } : {})}
        />
      ))}
    </Svg24>
  );
}

export function IconChevronDown(props: IconProps) {
  return <Huge icon={ArrowDown01Icon} {...props} />;
}

export function IconPin(props: IconProps) {
  return <Huge icon={Pin02Icon} {...props} />;
}

export function IconTrash(props: IconProps) {
  return <Huge icon={Delete02Icon} {...props} />;
}

export function IconChevronRight(props: IconProps) {
  return <Huge icon={ArrowRight01Icon} {...props} />;
}

export function IconChevronLeft(props: IconProps) {
  return <Huge icon={ArrowLeft01Icon} {...props} />;
}

export function IconCheck(props: IconProps) {
  return <Huge icon={Tick02Icon} {...props} />;
}

export function IconClose(props: IconProps) {
  return <Huge icon={Cancel01Icon} {...props} />;
}

export function IconCopy(props: IconProps) {
  return <Huge icon={Copy01Icon} {...props} />;
}

export function IconPlus(props: IconProps) {
  return <Huge icon={Add01Icon} {...props} />;
}

export function IconDownload(props: IconProps) {
  return <Huge icon={Download01Icon} {...props} />;
}

export function IconArrowUp(props: IconProps) {
  return <Huge icon={ArrowUp02Icon} {...props} />;
}

export function IconPencil(props: IconProps) {
  return <Huge icon={PencilEdit01Icon} {...props} />;
}

export function IconSearch(props: IconProps) {
  return <Huge icon={Search01Icon} {...props} />;
}

export function IconChat(props: IconProps) {
  return <FromGlyph glyph="chat" {...props} />;
}

export function IconSidebar(props: IconProps) {
  return <Huge icon={SidebarLeftIcon} {...props} />;
}

export function IconChart(props: IconProps) {
  return <Huge icon={Analytics01Icon} {...props} />;
}

export function IconTerminal(props: IconProps) {
  return <Huge icon={CommandLineIcon} {...props} />;
}

export function IconFile(props: IconProps) {
  return <Huge icon={File02Icon} {...props} />;
}

export function IconCode(props: IconProps) {
  return <Huge icon={SourceCodeIcon} {...props} />;
}

export function IconClock(props: IconProps) {
  return <Huge icon={Clock01Icon} {...props} />;
}

export function IconSettings(props: IconProps) {
  return <Huge icon={Settings01Icon} {...props} />;
}

export function IconGears(props: IconProps) {
  return <Huge icon={Wrench01Icon} {...props} />;
}

export function IconExternal(props: IconProps) {
  return <Huge icon={LinkSquare02Icon} {...props} />;
}

export function IconVideo(props: IconProps) {
  return <Huge icon={Video01Icon} {...props} />;
}

export function IconWaveform(props: IconProps) {
  return <FromGlyph glyph="audio" {...props} />;
}

export function IconDiff(props: IconProps) {
  return <Huge icon={GitCompareIcon} {...props} />;
}

export function IconMic(props: IconProps) {
  return <Huge icon={Mic01Icon} {...props} />;
}

export function IconInfo(props: IconProps) {
  return <Huge icon={InformationCircleIcon} {...props} />;
}

export function IconRefresh(props: IconProps) {
  return <Huge icon={Refresh01Icon} {...props} />;
}

export function IconThumbUp(props: IconProps) {
  return <Huge icon={ThumbsUpIcon} {...props} />;
}

export function IconThumbDown(props: IconProps) {
  return <Huge icon={ThumbsDownIcon} {...props} />;
}

export function IconShare(props: IconProps) {
  return <Huge icon={Share03Icon} {...props} />;
}

export function IconMore(props: IconProps) {
  return <Huge icon={MoreHorizontalIcon} {...props} />;
}

export function IconGauge(props: IconProps) {
  return <Huge icon={PieChartIcon} {...props} />;
}

export function IconSpeed(props: IconProps) {
  return <Huge icon={DashboardSpeed02Icon} {...props} />;
}

export function IconCamera(props: IconProps) {
  return <Huge icon={Camera01Icon} {...props} />;
}

export function IconImage(props: IconProps) {
  return <FromGlyph glyph="image" {...props} />;
}

export function IconFilm(props: IconProps) {
  return <FromGlyph glyph="video" {...props} />;
}

export function IconPaperclip(props: IconProps) {
  return <Huge icon={Attachment01Icon} {...props} />;
}

/** GitHub's own mark (simple-icons, CC0): filled, the one non-stroke icon. */
export function IconGithub(props: IconProps) {
  return (
    <Svg24 {...props}>
      <path
        d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"
        fill="currentColor"
        stroke="none"
      />
    </Svg24>
  );
}

export function IconConnector(props: IconProps) {
  return <Huge icon={Plug01Icon} {...props} />;
}

export function IconPuzzle(props: IconProps) {
  return <FromGlyph glyph="extensions" {...props} />;
}

export function IconGlobe(props: IconProps) {
  return <Huge icon={Globe02Icon} {...props} />;
}

export function IconBrain(props: IconProps) {
  return <Huge icon={AiBrain01Icon} {...props} />;
}

export function IconSparkles(props: IconProps) {
  return <Huge icon={SparklesIcon} {...props} />;
}

export function IconFolder(props: IconProps) {
  return <FromGlyph glyph="folder" {...props} />;
}

export function IconFolderOpen(props: IconProps) {
  return <FromGlyph glyph="folderOpen" {...props} />;
}

export function IconHandoff(props: IconProps) {
  return <Huge icon={SentIcon} {...props} />;
}

export function IconOrg(props: IconProps) {
  return <Huge icon={HierarchySquare02Icon} {...props} />;
}

export function IconSubmit(props: IconProps) {
  return <Huge icon={TaskDone01Icon} {...props} />;
}

export function IconGateOpen(props: IconProps) {
  return <Huge icon={CheckmarkCircle02Icon} {...props} />;
}

export function IconFolderPlus(props: IconProps) {
  return <Huge icon={FolderAddIcon} {...props} />;
}

export function IconCompass(props: IconProps) {
  return <FromGlyph glyph="discover" {...props} />;
}

export function IconCursor(props: IconProps) {
  return <Huge icon={Cursor01Icon} {...props} />;
}

export function IconKeyboard(props: IconProps) {
  return <Huge icon={KeyboardIcon} {...props} />;
}

export function IconEye(props: IconProps) {
  return <Huge icon={ViewIcon} {...props} />;
}

// ── the app-local set (Settings, Models, media), on the same drawings ──────

/** Play: start a run, a preview, a voice. */
export function IconPlay(props: IconProps) {
  return <Huge icon={PlayIcon} {...props} />;
}

/** Stop. */
export function IconStop(props: IconProps) {
  return <Huge icon={StopIcon} {...props} />;
}

/** Pause. */
export function IconPause(props: IconProps) {
  return <Huge icon={PauseIcon} {...props} />;
}

/** The processor. */
export function IconCpu(props: IconProps) {
  return <Huge icon={CpuIcon} {...props} />;
}

/** Needs a look. */
export function IconWarning(props: IconProps) {
  return <Huge icon={Alert02Icon} {...props} />;
}

/** Done, settled, verified. */
export function IconCheckCircle(props: IconProps) {
  return <Huge icon={CheckmarkCircle02Icon} {...props} />;
}

/** Kept safe: permissions, privacy. */
export function IconShield(props: IconProps) {
  return <Huge icon={Shield01Icon} {...props} />;
}

/** A key or a token. */
export function IconKey(props: IconProps) {
  return <Huge icon={Key01Icon} {...props} />;
}

/** Tuning controls. */
export function IconSlider(props: IconProps) {
  return <Huge icon={SlidersHorizontalIcon} {...props} />;
}

/** Light appearance. */
export function IconSun(props: IconProps) {
  return <Huge icon={Sun03Icon} {...props} />;
}

/** Dark appearance. */
export function IconMoon(props: IconProps) {
  return <Huge icon={Moon02Icon} {...props} />;
}

/** A favourite. */
export function IconStar(props: IconProps) {
  return <Huge icon={StarIcon} {...props} />;
}

/** Locked. */
export function IconLock(props: IconProps) {
  return <Huge icon={SquareLock02Icon} {...props} />;
}

/** Fast, or power. */
export function IconBolt(props: IconProps) {
  return <Huge icon={FlashIcon} {...props} />;
}

/** One sparkle: a single generated touch. */
export function IconSparkle(props: IconProps) {
  return <Huge icon={SparkleIcon} {...props} />;
}

/** Music. */
export function IconMusic(props: IconProps) {
  return <Huge icon={MusicNote03Icon} {...props} />;
}

/** A 3D object. */
export function IconCube(props: IconProps) {
  return <Huge icon={CubeIcon} {...props} />;
}

/** Hot, trending, heavy load. */
export function IconFlame(props: IconProps) {
  return <Huge icon={FireIcon} {...props} />;
}

/** A compact list: a view that shows rows only. */
export function IconListCompact(props: IconProps) {
  return <Huge icon={Menu01Icon} {...props} />;
}

/** A layout with a narrow pane on the right (a split view). */
export function IconLayoutRight(props: IconProps) {
  return <Huge icon={LayoutRightIcon} {...props} />;
}

/** A layout with a narrow pane on the left (a detail view). */
export function IconLayoutLeft(props: IconProps) {
  return <Huge icon={LayoutLeftIcon} {...props} />;
}

/** Some application: four rounded squares. */
export function IconApps(props: IconProps) {
  return <Huge icon={DashboardSquare01Icon} {...props} />;
}

/** The canvas, the panel beside the chat. */
export function IconPanelRight(props: IconProps) {
  return <Huge icon={PanelRightIcon} {...props} />;
}

/** Open bigger: arrows apart on the ↖↘ diagonal (the user: "a diagonal arrow pointing up left and down right"). */
export function IconExpand(props: IconProps) {
  return <Huge icon={ArrowExpand02Icon} {...props} />;
}

/** The 3D Studio, as the sidebar draws it. */
export function IconStudio3d(props: IconProps) {
  return <FromGlyph glyph="studio3d" {...props} />;
}
