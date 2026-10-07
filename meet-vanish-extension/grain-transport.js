(function(root) {
  "use strict";
  // One GPU point per source grain. The SAME birth texture controls both the
  // vacancy in the person and the grain leaving it. The room is never dithered.
  const VERTEX = `
    attribute vec2 aPosition; varying vec2 vUv;
    void main(){vUv=aPosition*.5+.5;gl_Position=vec4(aPosition,0.,1.);}
  `;
  const MASK = `
    float body(sampler2D mask,vec2 uv){
      return step(.5,texture2D(mask,uv).r);
    }
  `;
  const SCENE = `
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D uCamera,uRoom,uMask,uBirth;
     uniform vec2 uMaskSize,uBirthSize;
    uniform float uProgress;
    ${MASK}
    void main(){
       // Smooth between cells, but keep a flat center so camera removal and
       // grain birth start together (ordinary bilinear noise delays removal).
       vec2 cell=vUv*uBirthSize-.5;
       vec2 blend=smoothstep(vec2(.25),vec2(.75),fract(cell));
       vec2 birthUv=(floor(cell)+.5+blend)/uBirthSize;
       float birth=texture2D(uBirth,birthUv).r;
       // A short LOCAL handoff, not a whole-person fade or a moving cut line.
       // Unborn cells remain exactly opaque; their color becomes flying dust.
       float attached=body(uMask,vUv)*(1.-smoothstep(birth,birth+.04,uProgress));
      gl_FragColor=mix(texture2D(uRoom,vUv),texture2D(uCamera,vUv),attached);
    }
  `;
  const POINTS = `
    precision highp float;
     attribute vec3 aPosition;
     uniform sampler2D uBirth,uOriginMask;
    uniform vec2 uMaskSize,uSize;
    uniform float uProgress,uGrainSize,uDrift;
    varying vec2 vOrigin;
    varying float vAlpha;
    ${MASK}
    float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
    void main(){
       float kind=aPosition.z;
       vec2 anchor=aPosition.xy;
       float rx=hash(anchor*731.+5.+kind*37.),ry=hash(anchor*811.+17.+kind*53.);
       // Keep the larger core grain, plus two finer fragments from the SAME cell.
       vec2 offset=kind<.5 ? vec2(0.) : (vec2(rx,ry)-.5)*uGrainSize*.55/uSize;
       vOrigin=anchor+offset;
       float birth=texture2D(uBirth,anchor).r;
       float rawAge=clamp((uProgress-birth)/(1.-birth),0.,1.);
       float age=rawAge*rawAge*(3.-2.*rawAge);
       float present=smoothstep(birth,birth+.018,uProgress)*body(uOriginMask,vOrigin);
       vec2 wind=vec2(42.+rx*120.,30.+ry*100.)*(1.+kind*.16);
       vec2 swirl=vec2(sin(age*5.+rx*6.)-sin(rx*6.),
         cos(age*4.+ry*6.)-cos(ry*6.))*10.;
       vec2 uv=vOrigin+(wind*age+swirl)*uDrift/uSize;
       gl_Position=present>.001 ? vec4(uv*2.-1.,0.,1.) : vec4(3.,3.,0.,1.);
       float size=kind<.5 ? .85+rx*.30 : (kind<1.5 ? .52 : .34);
       gl_PointSize=uGrainSize*size*(1.-age*.32);
      vAlpha=present*(1.-smoothstep(.35,1.,age));
    }
  `;
  const GRAIN = `
    precision highp float;
    uniform sampler2D uPalette;
    varying vec2 vOrigin; varying float vAlpha;
    void main(){
      float radius=length(gl_PointCoord-.5);
      if(radius>.5 || vAlpha<=.001) discard;
      vec3 color=texture2D(uPalette,vOrigin).rgb;
      gl_FragColor=vec4(color,vAlpha*(1.-smoothstep(.35,.5,radius)));
    }
  `;
  function prepare(options) {
    let gl;
    const textures=[],buffers=[],programs=[];
    let disposed=false,ready=false,originReady=false;
    let camera=options.video,room=options.background;
    let lastMask=null;
    const width=Math.floor(options.width),height=Math.floor(options.height);
     // Bound transient fill/copy work, rather than render an expensive 1080p
     // dust pass on every display refresh. Stream dimensions stay unchanged;
     // camera/room endpoints still bypass this pass at their full resolution.
     const renderScale=Math.min(1,1024/width,576/height);
     const renderWidth=Math.max(1,Math.round(width*renderScale));
     const renderHeight=Math.max(1,Math.round(height*renderScale));
    const canvas=document.createElement("canvas");
     canvas.width=renderWidth;canvas.height=renderHeight;
    try {
       gl=canvas.getContext("webgl", {alpha:false,antialias:false,preserveDrawingBuffer:false,
        premultipliedAlpha:false,depth:false,stencil:false});
      if(!gl || gl.getParameter(gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS)<2)
        throw new Error("GPU grain rendering unavailable");
      function program(vertex,fragment) {
        const p=gl.createProgram();programs.push(p);
        for(const [type,source] of [[gl.VERTEX_SHADER,vertex],[gl.FRAGMENT_SHADER,fragment]]) {
          const shader=gl.createShader(type);gl.shaderSource(shader,source);gl.compileShader(shader);
          if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS))
            throw new Error(gl.getShaderInfoLog(shader));
          gl.attachShader(p,shader);gl.deleteShader(shader);
        }
        gl.linkProgram(p);
        if(!gl.getProgramParameter(p,gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
        return p;
      }
      const scene=program(VERTEX,SCENE),points=program(POINTS,GRAIN);
       const locations=new Map();
      function texture(unit) {
        const tex=gl.createTexture();textures.push(tex);
        gl.activeTexture(gl.TEXTURE0+unit);gl.bindTexture(gl.TEXTURE_2D,tex);
        gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
        return tex;
      }
      const live=texture(0),background=texture(1),mask=texture(2),
        births=texture(3),origin=texture(4),palette=texture(5);
      function image(unit,tex,source) {
        gl.activeTexture(gl.TEXTURE0+unit);gl.bindTexture(gl.TEXTURE_2D,tex);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,true);
        gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,source);
      }
      // createImageBitmap() backgrounds ignore WebGL's UNPACK_FLIP_Y flag.
      // Normalize the saved room to a DOM canvas first, so uploads use the
      // SAME top/bottom orientation as the live video and person mask.
      const roomUpload=document.createElement("canvas");
      roomUpload.width=room.naturalWidth || room.width || width;
      roomUpload.height=room.naturalHeight || room.height || height;
      roomUpload.getContext("2d").drawImage(room,0,0,roomUpload.width,roomUpload.height);
      image(0,live,camera);image(1,background,roomUpload);image(5,palette,camera);
      roomUpload.width=roomUpload.height=1;
      // Twice v1.7's cell spacing and diameter, with 1/4 as many grains.
      // Keep the approved birth/flight/reverse logic unchanged.
      const cell=Math.max(4,Math.min(6,width/250));
      const cols=Math.ceil(width/cell),rows=Math.ceil(height/cell);
      const data=new Uint8Array(cols*rows);
      let grainCount=0;
      for(let y=0;y<rows;y++) for(let x=0;x<cols;x++) {
        const i=y*cols+x;
        // Quantized shared values prevent vertex/fragment rounding disagreement.
         // More release on the right, like a drifting cloud, but births stay
         // random on BOTH sides. This is NOT an ordered sweep or hard edge.
         const bias=Math.max(.25,Math.min(1.75,1+4*((x+.5)/cols-.5)));
         data[i]=Math.round(255*(.018+
           Math.pow(root.MeetVanishDust.hashGrain(x,y,7187),bias)*.72));
      }
      gl.activeTexture(gl.TEXTURE3);gl.bindTexture(gl.TEXTURE_2D,births);
       // Interpolate the shared birth field so vacancies have organic edges,
       // not visible 4–6 px square tiles. Grain anchors sample cell centers.
       gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
       gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,false);gl.pixelStorei(gl.UNPACK_ALIGNMENT,1);
      gl.texImage2D(gl.TEXTURE_2D,0,gl.LUMINANCE,cols,rows,0,gl.LUMINANCE,gl.UNSIGNED_BYTE,data);
      function buffer(data) {
        const b=gl.createBuffer();buffers.push(b);gl.bindBuffer(gl.ARRAY_BUFFER,b);
        gl.bufferData(gl.ARRAY_BUFFER,data,gl.STATIC_DRAW);return b;
      }
      const quad=buffer(new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]));
      const cloud=buffer(new Float32Array(0));
      const maskCanvas=document.createElement("canvas"),maskContext=maskCanvas.getContext("2d");
      function updatePersonMask(next) {
        if(disposed || !next || !Number.isInteger(next.width) || !Number.isInteger(next.height) ||
          next.width<1 || next.height<1 || next.width>512 || next.height>512 ||
          next.mask?.length!==next.width*next.height) return false;
        if(!next.mask.some(v=>v>=128)) return false;
        // Preserve a stable grain source; live attached pixels use refreshed masks.
        lastMask={width:next.width,height:next.height};
        maskCanvas.width=next.width;maskCanvas.height=next.height;
        const pixels=maskContext.createImageData(next.width,next.height);
        const support=new Uint8Array(next.mask.length);
        for(let y=0;y<next.height;y++) for(let x=0;x<next.width;x++) {
          const i=y*next.width+x;
          const inside=next.mask[i]>=128 ||
            (x>0 && next.mask[i-1]>=128) || (x+1<next.width && next.mask[i+1]>=128) ||
            (y>0 && next.mask[i-next.width]>=128) ||
            (y+1<next.height && next.mask[i+next.width]>=128);
          const value=inside ? 255 : 0;support[i]=value;
          pixels.data[i*4]=pixels.data[i*4+1]=pixels.data[i*4+2]=value;
          pixels.data[i*4+3]=255;
        }
        maskContext.putImageData(pixels,0,0);
        image(2,mask,maskCanvas);ready=true;
        if(!originReady) {
          image(4,origin,maskCanvas);image(5,palette,camera);originReady=true;
           const positions=new Float32Array(cols*rows*9);
          for(let y=0;y<rows;y++) for(let x=0;x<cols;x++) {
            const mx=Math.min(next.width-1,Math.floor((x+.5)/cols*next.width));
            const my=Math.min(next.height-1,Math.floor((1-(y+.5)/rows)*next.height));
            if(!support[my*next.width+mx]) continue;
             for(let kind=0;kind<3;kind++) {
               positions[grainCount*3]=(x+.5)/cols;
               positions[grainCount*3+1]=(y+.5)/rows;
               positions[grainCount*3+2]=kind;
               grainCount++;
             }
          }
          gl.bindBuffer(gl.ARRAY_BUFFER,cloud);
           gl.bufferData(gl.ARRAY_BUFFER,positions.subarray(0,grainCount*3),gl.STATIC_DRAW);
        }
        return true;
      }
      updatePersonMask(options.personMask);
      function uniform(p,name,value) {
         let table=locations.get(p);
         if(!table) {table=new Map();locations.set(p,table);}
         if(!table.has(name)) table.set(name,gl.getUniformLocation(p,name));
         const loc=table.get(name);
        if(Array.isArray(value)) gl.uniform2f(loc,...value);
        else if(name==="uCamera" || name==="uRoom" || name==="uMask" ||
          name==="uBirth" || name==="uOriginMask" || name==="uPalette") gl.uniform1i(loc,value);
        else gl.uniform1f(loc,value);
      }
      function use(p,b) {
        gl.useProgram(p);gl.bindBuffer(gl.ARRAY_BUFFER,b);
        const loc=gl.getAttribLocation(p,"aPosition");
         gl.enableVertexAttribArray(loc);gl.vertexAttribPointer(loc,p===points ? 3 : 2,gl.FLOAT,false,0,0);
      }
       gl.useProgram(scene);
       for(const [name,val] of Object.entries({uCamera:0,uRoom:1,uMask:2,uBirth:3,uBirthSize:[cols,rows]}))
         uniform(scene,name,val);
       gl.useProgram(points);
       for(const [name,val] of Object.entries({uBirth:3,uOriginMask:4,uPalette:5,
         uSize:[width,height],uGrainSize:cell*1.25*renderScale,uDrift:Math.min(width,height)/480}))
         uniform(points,name,val);
      return {
        renderer: "gpu-grain-transport",
        grainDiameter: cell*1.25,
         renderWidth,renderHeight,
         fragmentsPerCell:3,
        get grainCount(){return grainCount;},
        updatePersonMask,
        render(context,progress) {
          if(disposed) return;
          const p=Math.max(0,Math.min(1,progress));
          if(p===0 || (!ready && p<1)) {
            context.drawImage(camera,0,0,width,height);return;
          }
          if(p===1) {context.drawImage(room,0,0,width,height);return;}
          image(0,live,camera);
           gl.viewport(0,0,renderWidth,renderHeight);gl.disable(gl.BLEND);use(scene,quad);
           uniform(scene,"uProgress",p);
          gl.drawArrays(gl.TRIANGLES,0,6);
          gl.enable(gl.BLEND);gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);use(points,cloud);
           uniform(points,"uProgress",p);
          gl.drawArrays(gl.POINTS,0,grainCount);
          context.drawImage(canvas,0,0,width,height);
        },
        dispose() {
          if(disposed) return;disposed=true;
          textures.forEach(t=>gl.deleteTexture(t));buffers.forEach(b=>gl.deleteBuffer(b));
          programs.forEach(p=>gl.deleteProgram(p));camera=room=lastMask=null;
          maskCanvas.width=maskCanvas.height=canvas.width=canvas.height=1;
          gl.getExtension("WEBGL_lose_context")?.loseContext();
        }
      };
    } catch(error) {
      if(gl) {
        textures.forEach(t=>gl.deleteTexture(t));buffers.forEach(b=>gl.deleteBuffer(b));
        programs.forEach(p=>gl.deleteProgram(p));
        gl.getExtension("WEBGL_lose_context")?.loseContext();
      }
      console.warn("[Meet Vanish] Grain transport unavailable.",error);
      return null;
    }
  }
  root.MeetVanishGrainTransport={prepare};
})(globalThis);