"use strict";

(() => {
  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0));
  function angle(a, b, c) {
    const u = [a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0)];
    const v = [c.x - b.x, c.y - b.y, (c.z || 0) - (b.z || 0)];
    const denominator = Math.hypot(...u) * Math.hypot(...v);
    if (denominator < 1e-8) return 0;
    const cosine = u.reduce((sum, value, index) => sum + value * v[index], 0) / denominator;
    return Math.acos(Math.max(-1, Math.min(1, cosine))) * 180 / Math.PI;
  }

  function isVSign(points) {
    if (!Array.isArray(points) || points.length !== 21 ||
        points.some((point) => !point || !Number.isFinite(point.x) ||
          !Number.isFinite(point.y) || (point.z !== undefined && !Number.isFinite(point.z)))) return false;
    const wrist = points[0];
    const extended = (mcp, pip, dip, tip) => {
      const length = distance(points[mcp], points[pip]) +
        distance(points[pip], points[dip]) + distance(points[dip], points[tip]);
      return length > 1e-6 &&
        angle(points[mcp], points[pip], points[dip]) > 152 &&
        angle(points[pip], points[dip], points[tip]) > 148 &&
        distance(points[mcp], points[tip]) > length * 0.83 &&
        distance(wrist, points[tip]) > distance(wrist, points[pip]) * 1.12;
    };
    const folded = (mcp, pip, dip, tip) =>
      angle(points[mcp], points[pip], points[dip]) < 142 ||
      distance(wrist, points[tip]) < distance(wrist, points[pip]) * 1.07;
    if (!extended(5, 6, 7, 8) || !extended(9, 10, 11, 12) ||
        !folded(13, 14, 15, 16) || !folded(17, 18, 19, 20)) return false;

    const palmWidth = distance(points[5], points[17]);
    if (palmWidth < 1e-5 || distance(points[8], points[12]) < palmWidth * 0.38) return false;
    const origin = { x: 0, y: 0, z: 0 };
    const direction = (base, tip) => ({
      x: points[tip].x - points[base].x,
      y: points[tip].y - points[base].y,
      z: (points[tip].z || 0) - (points[base].z || 0)
    });
    const spread = angle(direction(5, 8), origin, direction(9, 12));
    return spread >= 9 && spread <= 85;
  }

  function createHoldGate(options = {}) {
    const holdMs = options.holdMs ?? 650;
    const releaseMs = options.releaseMs ?? 450;
    const cooldownMs = options.cooldownMs ?? 2300;
    const maxGapMs = options.maxGapMs ?? 800;
    let holdingSince = null;
    let releaseSince = null;
    let latched = false;
    let lastTrigger = -Infinity;
    let lastSample = null;
    return {
      update(isV, now) {
        if (!Number.isFinite(now) || (lastSample !== null && now < lastSample)) {
          return { triggered: false, latched, progress: 0 };
        }
        if (lastSample !== null && now - lastSample > maxGapMs) {
          holdingSince = null;
          releaseSince = null;
          // A stalled/hidden tab is not proof the user lowered their hand.
        }
        lastSample = now;
        let triggered = false;
        if (!isV) {
          holdingSince = null;
          if (releaseSince === null) releaseSince = now;
          if (now - releaseSince >= releaseMs) latched = false;
        } else {
          releaseSince = null;
          if (holdingSince === null) holdingSince = now;
          if (!latched && now - holdingSince >= holdMs && now - lastTrigger >= cooldownMs) {
            triggered = true;
            latched = true;
            lastTrigger = now;
          }
        }
        return {
          triggered,
          latched,
          progress: isV ? Math.min(1, (now - holdingSince) / holdMs) : 0
        };
      }
    };
  }
  globalThis.MeetVanishGestureRules = Object.freeze({ isVSign, createHoldGate });
})();