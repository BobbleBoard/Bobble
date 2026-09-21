import { describe, expect, it } from 'vitest';
import {
  AGENT_CURSOR_BODY,
  AGENT_CURSOR_BOX,
  AGENT_CURSOR_GLOW,
  AGENT_CURSOR_HEIGHT,
  AGENT_CURSOR_PATH,
  AGENT_CURSOR_STROKE_W,
  AGENT_CURSOR_TIP,
  agentCursorSize,
  agentCursorSvg,
  agentPillPlacement,
} from './agent-cursor';

/** Every anchor the path visits (M/L end points and arc end points). */
function anchors(d: string): [number, number][] {
  const out: [number, number][] = [];
  for (const m of d.matchAll(/([MLA])\s*([^MLAZ]*)/g)) {
    const nums = (m[2] ?? '')
      .trim()
      .split(/[\s,]+/)
      .filter((t) => t.length > 0)
      .map(Number);
    if (m[1] === 'A') {
      for (let i = 0; i + 6 < nums.length; i += 7) {
        out.push([nums[i + 5] as number, nums[i + 6] as number]);
      }
    } else {
      for (let i = 0; i + 1 < nums.length; i += 2) {
        out.push([nums[i] as number, nums[i + 1] as number]);
      }
    }
  }
  return out;
}

describe('the agent cursor', () => {
  it('draws inside its box with the keyline to spare, tip at the top-left point', () => {
    const half = AGENT_CURSOR_STROKE_W / 2;
    for (const [x, y] of anchors(AGENT_CURSOR_PATH)) {
      expect(x - half).toBeGreaterThanOrEqual(AGENT_CURSOR_BOX.x);
      expect(x + half).toBeLessThanOrEqual(AGENT_CURSOR_BOX.x + AGENT_CURSOR_BOX.w);
      expect(y - half).toBeGreaterThanOrEqual(AGENT_CURSOR_BOX.y);
      expect(y + half).toBeLessThanOrEqual(AGENT_CURSOR_BOX.y + AGENT_CURSOR_BOX.h);
    }
    // The apex (67.563, 62.329) pulled out along the diagonal by 0.7 × half a
    // keyline, as the overlay measures it.
    const apex = { x: 67.563 - half * 0.7, y: 62.329 - half * 0.7 };
    expect(AGENT_CURSOR_TIP.x).toBeCloseTo((apex.x - AGENT_CURSOR_BOX.x) / AGENT_CURSOR_BOX.w, 4);
    expect(AGENT_CURSOR_TIP.y).toBeCloseTo((apex.y - AGENT_CURSOR_BOX.y) / AGENT_CURSOR_BOX.h, 4);
  });

  it('is 25.3 tall at real size, narrower than tall, tip a hair inside the corner', () => {
    const s = agentCursorSize();
    expect(s.h).toBe(AGENT_CURSOR_HEIGHT);
    expect(s.w).toBeCloseTo(22.14, 1);
    expect(s.tip.x).toBeCloseTo(1.53, 1);
    expect(s.tip.y).toBeCloseTo(0.92, 1);
  });

  it('the SVG is the overlay stack: shadow, blue rim, black body, white keyline at his width', () => {
    const svg = agentCursorSvg();
    expect(svg).toContain(`fill="${AGENT_CURSOR_BODY}"`);
    expect(svg).toContain(`stroke="#ffffff" stroke-width="${AGENT_CURSOR_STROKE_W}"`);
    expect(svg).toContain(`stroke="${AGENT_CURSOR_GLOW}"`);
    expect(svg).toContain('feGaussianBlur');
    expect(svg).toContain('overflow:visible');
    // Not the old frosted dart: no gradient, no pearl, no teal, no lavender.
    expect(svg).not.toMatch(/linearGradient|#78BFE5|#95F9E5|#c3c2e4/i);
    expect(svg.startsWith('<svg width="22.14" height="25.30"')).toBe(true);
  });

  it('parks the pill below-right, flips it inside the window, and clamps a corner', () => {
    const win = { x: 100, y: 100, w: 400, h: 300 };
    const size = { w: 120, h: 26 };
    expect(agentPillPlacement({ x: 150, y: 150 }, size, win)).toEqual({
      x: 161,
      y: 165,
      flipX: false,
      flipY: false,
    });
    // Near the right edge: the pill's right edge sits 11 left of the tip.
    const right = agentPillPlacement({ x: 480, y: 150 }, size, win);
    expect(right.flipX).toBe(true);
    expect(right.x + size.w).toBe(480 - 11);
    // Near the bottom: above the tip by 15.
    const bottom = agentPillPlacement({ x: 150, y: 390 }, size, win);
    expect(bottom.flipY).toBe(true);
    expect(bottom.y + size.h).toBe(390 - 15);
    // A tip in the top-left corner of a window narrower than the pill: clamped
    // 4 inside, never outside.
    const narrow = agentPillPlacement({ x: 102, y: 102 }, size, { x: 100, y: 100, w: 80, h: 60 });
    expect(narrow.x).toBe(100 + 80 - 4 - size.w);
    expect(narrow.y).toBe(102 + 15);
    // The scale scales the distances too (the canvas draws at a fraction).
    const half = agentPillPlacement({ x: 150, y: 150 }, size, win, 0.5);
    expect(half).toMatchObject({ x: 155.5, y: 157.5 });
  });
});
