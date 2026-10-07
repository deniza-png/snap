(function(root) {
  "use strict";
  function hashGrain(x,y,seed) {
    let value=Math.imul((x|0)+1,374761393)+Math.imul((y|0)+1,668265263)+
      Math.imul(seed|0,1442695041);
    value=Math.imul(value^(value>>>13),1274126177);
    value^=value>>>16;
    return (value>>>0)/4294967295;
  }
  function prepare(options) {
    if(!options?.video || !options.background || !Number.isFinite(options.width) ||
      !Number.isFinite(options.height) || options.width<1 || options.height<1 ||
      !(options.video.videoWidth || options.video.width) ||
      !(options.video.videoHeight || options.video.height) ||
      typeof document==="undefined" || !root.MeetVanishGrainTransport) return null;
    return root.MeetVanishGrainTransport.prepare(options);
  }
  // No whole-picture noise/dissolve fallback. An unavailable GPU is reported by
  // the camera pipeline and switches instantly instead of pretending to dust.
  const api={duration:2200,prepare,hashGrain};
  root.MeetVanishDust=api;
  if(typeof module!=="undefined" && module.exports) module.exports=api;
})(globalThis);