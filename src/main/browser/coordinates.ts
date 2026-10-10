import type { Box, BrowserGeometry, ScreenPoint } from '../../shared/types';

/**
 * Coordinate mapping (spec sections 3 and 14).
 *
 * Page CSS px -> Electron screen DIP. Two independent estimates are computed and
 * cross-checked, because display scaling, page zoom and window size all move the
 * mapping:
 *
 *   A. windowBounds: Chrome's `Browser.getWindowBounds` (DIP) plus a zoom scale
 *      derived from `bounds.width / innerWidth`.
 *   B. screenXY: `window.screenX/screenY` and `window.outerHeight` reported by
 *      the page itself (also DIP in Chrome).
 *
 * Both are in DIP, so they must agree. A disagreement larger than the tolerance
 * means something moved (docked DevTools, unusual zoom) and calibration warns.
 */

export interface WindowBoundsInput {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ViewportMetricsInput {
  innerWidth: number;
  innerHeight: number;
  outerHeight: number;
  screenX: number;
  screenY: number;
  devicePixelRatio: number;
}

/** Tolerance for the milestone 2 exit check: ghost lands within 8 px. */
export const CALIBRATION_TOLERANCE_PX = 8;

const MIN_SCALE = 0.2;
const MAX_SCALE = 5;

function clampScale(scale: number): number {
  if (!Number.isFinite(scale) || scale <= 0) return 1;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/**
 * Build the mapping. `scale` is DIP per CSS px: 1 at 100% page zoom, 1.25 at
 * 125% zoom, and so on. Display scaling itself is already baked into the DIP
 * values reported by Chrome and by Electron's screen API.
 */
export function buildGeometry(
  bounds: WindowBoundsInput,
  metrics: ViewportMetricsInput,
): BrowserGeometry {
  const scale = clampScale(metrics.innerWidth > 0 ? bounds.width / metrics.innerWidth : 1);

  const viewportWidth = metrics.innerWidth * scale;
  const viewportHeight = metrics.innerHeight * scale;

  // Method A: browser UI height comes from the outer bounds.
  const uiHeightA = Math.max(0, bounds.height - viewportHeight);
  const viewportTopA = bounds.top + uiHeightA;
  const viewportLeftA = bounds.left;

  // Method B: the page's own screen coordinates. outerHeight is DIP and is not
  // affected by page zoom, while innerHeight is CSS px, hence the scale.
  const uiHeightB = Math.max(0, metrics.outerHeight - viewportHeight);
  const viewportTopB = metrics.screenY + uiHeightB;
  const viewportLeftB = metrics.screenX;

  const crossCheckDelta =
    Math.abs(viewportTopA - viewportTopB) + Math.abs(viewportLeftA - viewportLeftB);

  return {
    bounds: { x: bounds.left, y: bounds.top, width: bounds.width, height: bounds.height },
    viewportLeft: viewportLeftA,
    viewportTop: viewportTopA,
    viewportWidth,
    viewportHeight,
    innerWidth: metrics.innerWidth,
    innerHeight: metrics.innerHeight,
    scale,
    devicePixelRatio: metrics.devicePixelRatio,
    source: 'windowBounds',
    crossCheckDelta,
  };
}

/** True when the two mapping methods agree closely enough to trust. */
export function calibrationOk(geometry: BrowserGeometry): boolean {
  return geometry.crossCheckDelta <= CALIBRATION_TOLERANCE_PX;
}

/** Center of a viewport-relative box, in page CSS px. */
export function elementCenter(box: Box): ScreenPoint {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Viewport-relative page CSS px -> absolute screen DIP. */
export function pagePointToScreen(geometry: BrowserGeometry, pagePoint: ScreenPoint): ScreenPoint {
  return {
    x: geometry.viewportLeft + pagePoint.x * geometry.scale,
    y: geometry.viewportTop + pagePoint.y * geometry.scale,
  };
}

/** Center of an element as an absolute screen point. */
export function elementCenterToScreen(geometry: BrowserGeometry, box: Box): ScreenPoint {
  return pagePointToScreen(geometry, elementCenter(box));
}

/** Screen DIP -> coordinates local to a display-sized overlay window. */
export function screenToOverlayLocal(displayBounds: Box, screenPoint: ScreenPoint): ScreenPoint {
  return { x: screenPoint.x - displayBounds.x, y: screenPoint.y - displayBounds.y };
}

/** True when a screen point falls inside a display's bounds. */
export function isInsideBounds(bounds: Box, point: ScreenPoint): boolean {
  return (
    point.x >= bounds.x &&
    point.x <= bounds.x + bounds.width &&
    point.y >= bounds.y &&
    point.y <= bounds.y + bounds.height
  );
}

export function distanceBetween(a: ScreenPoint, b: ScreenPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Spec section 5: 300 to 900 ms depending on distance. */
export function durationForDistance(distance: number): number {
  const duration = Math.round(280 + distance * 0.55);
  return Math.max(300, Math.min(900, duration));
}

export function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

/** Quadratic Bezier point; used for the ghost's curved path. */
export function quadraticBezier(
  p0: ScreenPoint,
  p1: ScreenPoint,
  p2: ScreenPoint,
  t: number,
): ScreenPoint {
  const u = 1 - t;
  return {
    x: u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x,
    y: u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y,
  };
}

/**
 * Control point for a gentle arc: perpendicular to the straight path, capped so
 * short moves stay nearly straight.
 */
export function arcControlPoint(from: ScreenPoint, to: ScreenPoint): ScreenPoint {
  const mid: ScreenPoint = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  const distance = distanceBetween(from, to);
  if (distance < 1) return mid;
  const dx = (to.x - from.x) / distance;
  const dy = (to.y - from.y) / distance;
  // Perpendicular, biased upward so the arc reads as a natural arm movement.
  const offset = Math.min(120, distance * 0.18);
  return { x: mid.x - dy * offset, y: mid.y + dx * offset - offset * 0.35 };
}

/** Sample the whole curved path; the overlay renderer animates through these. */
export function sampleArc(from: ScreenPoint, to: ScreenPoint, steps = 32): ScreenPoint[] {
  const control = arcControlPoint(from, to);
  const points: ScreenPoint[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    points.push(quadraticBezier(from, control, to, easeInOut(t)));
  }
  return points;
}

/**
 * Clamp a target that is outside the display: the ghost points toward it from the
 * nearest edge (spec section 8: "If off screen, point toward it and hint to
 * scroll").
 */
export function clampToEdge(bounds: Box, point: ScreenPoint, margin = 48): ScreenPoint {
  return {
    x: Math.min(bounds.x + bounds.width - margin, Math.max(bounds.x + margin, point.x)),
    y: Math.min(bounds.y + bounds.height - margin, Math.max(bounds.y + margin, point.y)),
  };
}

