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