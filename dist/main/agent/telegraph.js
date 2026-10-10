"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.telegraph = telegraph;
const electron_1 = require("electron");
const types_1 = require("../../shared/types");
const coordinates_1 = require("../browser/coordinates");
/**
 * Telegraph (spec section 5 and 8).
 *
 * Before anything happens, the ghost cursor visibly moves to the target along a
 * curved path, pauses at least 400 ms and pulses. Only after that does the agent
 * dispatch a CDP event. The user can always see what is about to happen, and can
 * stop it with Esc.
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function telegraph(options) {
    const { overlay, geometry, bbox } = options;
    const target = (0, coordinates_1.elementCenterToScreen)(geometry, bbox);
    const display = electron_1.screen.getPrimaryDisplay();
    const onScreen = (0, coordinates_1.isInsideBounds)(display.bounds, target);
    const from = options.from ?? {
        x: display.bounds.x + display.bounds.width / 2,
        y: display.bounds.y + display.bounds.height / 2,
    };
    const durationMs = Math.max(options.minDurationMs ?? 0, (0, coordinates_1.durationForDistance)((0, coordinates_1.distanceBetween)(from, target)));
    if (onScreen) {
        overlay.move(target.x, target.y, durationMs, options.hint);
    }
    else {
        // Off screen: point toward it from the nearest edge and hint to scroll.
        const edge = (0, coordinates_1.clampToEdge)(display.bounds, target);
        overlay.offscreen(edge.x, edge.y, options.hint ?? 'Off screen - scroll to bring it into view');
    }
    // Visible for the whole move plus the mandatory pause before any dispatch.
    await sleep(durationMs + types_1.TELEGRAPH_PAUSE_MS);
    overlay.pulse();
    return { target, onScreen, durationMs };
}
//# sourceMappingURL=telegraph.js.map