"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const context = {};
vm.runInNewContext(fs.readFileSync("meet-vanish-extension/gesture-rules.js", "utf8"), context);
const { isVSign, createHoldGate } = context.MeetVanishGestureRules;

function hand() {
  const points = Array.from({ length: 21 }, () => ({ x: 0, y: 0, z: 0 }));
  const finger = (base, coordinates) => coordinates.forEach(([x, y], i) => { points[base + i] = { x, y, z: 0 }; });
  finger(5, [[-.22, -.45], [-.37, -.8], [-.48, -1.05], [-.6, -1.3]]);
  finger(9, [[.03, -.5], [.16, -.9], [.25, -1.18], [.35, -1.48]]);
  finger(13, [[.27, -.44], [.4, -.7], [.33, -.55], [.25, -.38]]);
  finger(17, [[.45, -.3], [.62, -.5], [.51, -.4], [.43, -.27]]);
  return points;
}
function replaceFinger(points, base, coordinates) {
  coordinates.forEach(([x, y], i) => { points[base + i] = { x, y, z: 0 }; });
}
let count = 0;
function test(name, fn) { fn(); count++; console.log(`PASS ${name}`); }
test("V pose requires index and middle extended, ring and pinky folded", () => {
  assert.equal(isVSign(hand()), true);
});
test("mirrored, rotated and tilted V signs remain valid", () => {
  const original = hand();
  assert.equal(isVSign(original.map((p) => ({ ...p, x: -p.x }))), true);
  assert.equal(isVSign(original.map((p) => ({
    x: p.x * Math.cos(.7) - p.y * Math.sin(.7),
    y: p.x * Math.sin(.7) + p.y * Math.cos(.7), z: 0
  }))), true);
  assert.equal(isVSign(original.map((p) => ({
    x: p.x, y: p.y * Math.cos(.5), z: p.y * Math.sin(.5)
  }))), true);
});
test("open palm is not a V sign", () => {
  const points = hand();
  replaceFinger(points, 13, [[.27,-.44],[.3,-.8],[.32,-1.05],[.34,-1.3]]);
  replaceFinger(points, 17, [[.45,-.3],[.5,-.6],[.55,-.8],[.6,-1]]);
  assert.equal(isVSign(points), false);
});
test("fist and single-finger poses are not V signs", () => {
  const points = hand();
  replaceFinger(points, 9, [[.03,-.5],[.1,-.8],[.05,-.6],[.03,-.4]]);
  assert.equal(isVSign(points), false);
  replaceFinger(points, 5, [[-.22,-.45],[-.3,-.7],[-.23,-.5],[-.2,-.35]]);
  assert.equal(isVSign(points), false);
});
test("two parallel fingers together are not accepted as a V", () => {
  const points = hand();
  replaceFinger(points, 5, [[-.22,-.45],[-.22,-.8],[-.22,-1.05],[-.22,-1.3]]);
  replaceFinger(points, 9, [[.03,-.5],[.03,-.9],[.03,-1.18],[.03,-1.48]]);
  assert.equal(isVSign(points), false);
});
test("invalid or missing landmark data is rejected", () => {
  assert.equal(isVSign([]), false);
  const points = hand();
  points[12].x = NaN;
  assert.equal(isVSign(points), false);
});
test("real MediaPipe image landmarks of a V sign pass", () => {
  // MediaPipe's victory.jpg sampled like the camera (302x320 JPEG), x and z in height units as
  // gesture-engine.js passes them. World landmarks of the same hand fail the fingertip angle.
  const points = [
    [0.4902, 0.807, 0], [0.5712, 0.7125, -0.0405], [0.5917, 0.5906, -0.0578],
    [0.499, 0.5239, -0.08], [0.4032, 0.5, -0.1018], [0.53, 0.4501, -0.015],
    [0.544, 0.3227, -0.0472], [0.5462, 0.2427, -0.0702], [0.5483, 0.1707, -0.0866],
    [0.4438, 0.4611, -0.0311], [0.4172, 0.3156, -0.0725], [0.4014, 0.2217, -0.1029],
    [0.3824, 0.1415, -0.1199], [0.3743, 0.5081, -0.0536], [0.3422, 0.44, -0.124],
    [0.3944, 0.5284, -0.1393], [0.4271, 0.5959, -0.1282], [0.3145, 0.576, -0.0789],
    [0.2929, 0.5058, -0.1262], [0.3363, 0.5584, -0.1203], [0.3712, 0.6115, -0.1048]
  ].map(([x, y, z]) => ({ x, y, z }));
  assert.equal(isVSign(points), true);
});
test("hold gate fires once, waits for release, and can fire again", () => {
  const gate = createHoldGate();
  let triggers = 0;
  for (let t = 0; t <= 3000; t += 150) if (gate.update(true, t).triggered) triggers++;
  assert.equal(triggers, 1);
  for (let t = 3150; t <= 3750; t += 150) gate.update(false, t);
  for (let t = 3900; t <= 4800; t += 150) if (gate.update(true, t).triggered) triggers++;
  assert.equal(triggers, 2);
});
test("brief release flicker cannot retrigger and missed frames cannot complete a hold", () => {
  const gate = createHoldGate();
  assert.equal(gate.update(true, 0).triggered, false);
  assert.equal(gate.update(true, 1500).triggered, false);
  for (let t = 1650; t <= 2250; t += 150) gate.update(true, t);
  gate.update(false, 2400);
  assert.equal(gate.update(true, 2550).triggered, false);
  assert.equal(gate.update(true, 10_000).triggered, false);
});
test("cooldown prevents rapid repeated gestures even after release", () => {
  const gate = createHoldGate();
  for (let t = 0; t <= 750; t += 150) gate.update(true, t);
  for (let t = 900; t <= 1350; t += 150) gate.update(false, t);
  for (let t = 1500; t <= 2850; t += 150) assert.equal(gate.update(true, t).triggered, false);
  assert.equal(gate.update(true, 3150).triggered, true);
});
console.log(`\n${count}/${count} gesture tests passed.`);