import { screen } from 'electron';
import { TELEGRAPH_PAUSE_MS } from '../../shared/types';
import type { Box, BrowserGeometry, ScreenPoint } from '../../shared/types';
import {
  clampToEdge,
  distanceBetween,
  durationForDistance,
  elementCenterToScreen,
  isInsideBounds,
} from '../browser/coordinates';
import type { OverlayWindow } from '../ui/overlayWindow';

/**
 * Telegraph (spec section 5 and 8).
 *
 * Before anything happens, the ghost cursor visibly moves to the target along a
 * curved path, pauses at least 400 ms and pulses. Only after that does the agent
 * dispatch a CDP event. The user can always see what is about to happen, and can
 * stop it with Esc.
 */

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface TelegraphOptions {
  overlay: OverlayWindow;
  geometry: BrowserGeometry;
  /** Element box in viewport-relative page CSS px. */
  bbox: Box;
  hint?: string;
  /** Previous cursor position, used for the duration estimate. */
  from?: ScreenPoint | null;
  minDurationMs?: number;
}

export interface TelegraphResult {
  /** Target in absolute screen DIP. */
  target: ScreenPoint;
  onScreen: boolean;
  durationMs: number;
}

export async function telegraph(options: TelegraphOptions): Promise<TelegraphResult> {
  const { overlay, geometry, bbox } = options;
  const target = elementCenterToScreen(geometry, bbox);
  const display = screen.getPrimaryDisplay();
  const onScreen = isInsideBounds(display.bounds, target);

  const from =
    options.from ?? {
      x: display.bounds.x + display.bounds.width / 2,
      y: display.bounds.y + display.bounds.height / 2,
    };
  const durationMs = Math.max(
    options.minDurationMs ?? 0,
    durationForDistance(distanceBetween(from, target)),
  );

  if (onScreen) {
    overlay.move(target.x, target.y, durationMs, options.hint);
  } else {
    // Off screen: point toward it from the nearest edge and hint to scroll.
    const edge = clampToEdge(display.bounds, target);
    overlay.offscreen(edge.x, edge.y, options.hint ?? 'Off screen - scroll to bring it into view');
  }

  // Visible for the whole move plus the mandatory pause before any dispatch.
  await sleep(durationMs + TELEGRAPH_PAUSE_MS);
  overlay.pulse();
  return { target, onScreen, durationMs };
}
