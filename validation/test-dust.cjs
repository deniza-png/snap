"use strict";
const assert=require("node:assert/strict");
const dust=require("../meet-vanish-extension/dust-effect.js");
assert.equal(dust.duration,2200);
const samples=[];
for(let y=0;y<100;y++) for(let x=0;x<100;x++) {
  const sample=dust.hashGrain(x,y,7187);
  assert.ok(sample>=0 && sample<=1);
  assert.equal(sample,dust.hashGrain(x,y,7187),"grain birth is deterministic for reversal");
  samples.push(sample);
}
const mean=samples.reduce((a,b)=>a+b,0)/samples.length;
assert.ok(mean>.48 && mean<.52,"grain births are distributed, not a clipping front");
assert.equal(dust.prepare({video:{width:640,height:480},background:{},
  width:640,height:480}),null,"missing GPU must not fall back to full-scene noise");
assert.equal(dust.prepare(null),null);
assert.equal(dust.prepare({}),null);
assert.equal(dust.prepare({video:{width:640,height:480},background:{},
  width:NaN,height:480}),null);
// These are helper checks only. This repository's automated suite does not
// exercise WebGL, real-person segmentation, or production Google Meet.
console.log("Grain timing and safe GPU-dispatch tests passed.");