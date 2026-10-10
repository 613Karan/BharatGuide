"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CALIBRATION_TOLERANCE_PX = void 0;
exports.buildGeometry = buildGeometry;
exports.calibrationOk = calibrationOk;
exports.elementCenter = elementCenter;
exports.pagePointToScreen = pagePointToScreen;
exports.elementCenterToScreen = elementCenterToScreen;
exports.screenToOverlayLocal = screenToOverlayLocal;
exports.isInsideBounds = isInsideBounds;
exports.distanceBetween = distanceBetween;
exports.durationForDistance = durationForDistance;
exports.easeInOut = easeInOut;
exports.quadraticBezier = quadraticBezier;
exports.arcControlPoint = arcControlPoint;
exports.sampleArc = sampleArc;
exports.clampToEdge = clampToEdge;
/** Tolerance for the milestone 2 exit check: ghost lands within 8 px. */
exports.CALIBRATION_TOLERANCE_PX = 8;
const MIN_SCALE = 0.2;
const MAX_SCALE = 5;
function clampScale(scale) {
    if (!Number.isFinite(scale) || scale <= 0)
        return 1;
    return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}
/**
 * Build the mapping. `scale` is DIP per CSS px: 1 at 100% page zoom, 1.25 at
 * 125% zoom, and so on. Display scaling itself is already baked into the DIP
 * values reported by Chrome and by Electron's screen API.
 */
function buildGeometry(bounds, metrics) {
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
    const crossCheckDelta = Math.abs(viewportTopA - viewportTopB) + Math.abs(viewportLeftA - viewportLeftB);
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
function calibrationOk(geometry) {
    return geometry.crossCheckDelta <= exports.CALIBRATION_TOLERANCE_PX;
}
/** Center of a viewport-relative box, in page CSS px. */
function elementCenter(box) {
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}
/** Viewport-relative page CSS px -> absolute screen DIP. */
function pagePointToScreen(geometry, pagePoint) {
    return {
        x: geometry.viewportLeft + pagePoint.x * geometry.scale,
        y: geometry.viewportTop + pagePoint.y * geometry.scale,
    };
}
/** Center of an element as an absolute screen point. */
function elementCenterToScreen(geometry, box) {
    return pagePointToScreen(geometry, elementCenter(box));
}
/** Screen DIP -> coordinates local to a display-sized overlay window. */
function screenToOverlayLocal(displayBounds, screenPoint) {
    return { x: screenPoint.x - displayBounds.x, y: screenPoint.y - displayBounds.y };
}
/** True when a screen point falls inside a display's bounds. */
function isInsideBounds(bounds, point) {
    return (point.x >= bounds.x &&
        point.x <= bounds.x + bounds.width &&
        point.y >= bounds.y &&
        point.y <= bounds.y + bounds.height);
}
function distanceBetween(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
}
/** Spec section 5: 300 to 900 ms depending on distance. */
function durationForDistance(distance) {
    const duration = Math.round(280 + distance * 0.55);
    return Math.max(300, Math.min(900, duration));
}
function easeInOut(t) {
    return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}
/** Quadratic Bezier point; used for the ghost's curved path. */
function quadraticBezier(p0, p1, p2, t) {
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
function arcControlPoint(from, to) {
    const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
    const distance = distanceBetween(from, to);
    if (distance < 1)
        return mid;
    const dx = (to.x - from.x) / distance;
    const dy = (to.y - from.y) / distance;
    // Perpendicular, biased upward so the arc reads as a natural arm movement.
    const offset = Math.min(120, distance * 0.18);
    return { x: mid.x - dy * offset, y: mid.y + dx * offset - offset * 0.35 };
}
/** Sample the whole curved path; the overlay renderer animates through these. */
function sampleArc(from, to, steps = 32) {
    const control = arcControlPoint(from, to);
    const points = [];
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
function clampToEdge(bounds, point, margin = 48) {
    return {
        x: Math.min(bounds.x + bounds.width - margin, Math.max(bounds.x + margin, point.x)),
        y: Math.min(bounds.y + bounds.height - margin, Math.max(bounds.y + margin, point.y)),
    };
}
//# sourceMappingURL=coordinates.js.map