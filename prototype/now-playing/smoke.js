/* The source is the mock's independent smoke layer, never the album cover.
 * A stationary high-frequency residual keeps the Photoshop grain on the screen.
 * Only the softened smoke is slowly advected. Palette values come from CSS. */
(() => {
  const canvas = document.querySelector('#smoke');
  const capture = new URLSearchParams(location.search).get('capture') === '1';
  const media = matchMedia('(prefers-reduced-motion: reduce)');
  let gl, program, ready = false, moving = true, lastDraw = -Infinity, phase = 0;
  // 調整可能なパラメータ。既定値は「差し替え前とまったく同じ絵」になる値。
  // tune.js（?tune=1 のときだけ動く）から setParams() で上書きされる。
  // 2026-09-06 に調整パネルで人間が決めた値。PSD の粒を半分に落とし、
  // 代わりに細かい追加ノイズを乗せ、煙をやや大きく・速く流している。
  const defaults = {
    grainAmount: .5, noiseAmount: .045, noisePixel: 2,
    driftAmount: .016, driftSpeed: 3, smokeScale: 1.08, softness: 0,
    saturation: 1, brightness: 1, contrast: 1,
  };
  const params = { ...defaults };
  let uniforms = null;
  let target, current, referenceInverse;
  const rgb = hex => hex.trim().replace('#', '').match(/../g).map(v => parseInt(v, 16) / 255);
  const matrix = p => ['primary', 'secondary', 'shadow'].flatMap(k => rgb(p[k]));
  function inverse(m) {
    const rows = [0, 1, 2].map(r => [m[r], m[r + 3], m[r + 6], ...[0, 1, 2].map(c => +(c === r))]);
    for (let i = 0; i < 3; i++) {
      const pivot = rows[i][i];
      for (let c = 0; c < 6; c++) rows[i][c] /= pivot;
      for (let r = 0; r < 3; r++) if (r !== i) {
        const factor = rows[r][i];
        for (let c = 0; c < 6; c++) rows[r][c] -= factor * rows[i][c];
      }
    }
    return [0, 1, 2].flatMap(c => [0, 1, 2].map(r => rows[r][c + 3]));
  }
  function readPalette() {
    const style = getComputedStyle(document.documentElement);
    target = matrix(Object.fromEntries(['primary', 'secondary', 'shadow'].map(k => [k, style.getPropertyValue(`--art-${k}`)])));
    if (!current) current = target.slice();
    lastDraw = -Infinity;
    if (canvas.dataset.renderer === 'static-fallback') document.body.style.backgroundBlendMode = 'luminosity';
  }
  function shader(kind, source) {
    const s = gl.createShader(kind); gl.shaderSource(s, source); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('Smoke shader compilation failed');
    return s;
  }
  function showStatic() {
    canvas.style.opacity = '0';
    // Keep the large data URL out of a shorthand containing var().
    document.body.style.backgroundImage = `url('${window.SmokeTextures['smoke-grain.png']}')`;
    document.body.style.backgroundColor = 'var(--art-primary)';
    document.body.style.backgroundPosition = 'center';
    document.body.style.backgroundSize = '100% 100%';
  }
  async function init() {
    referenceInverse = inverse(matrix(window.MockData.palettes.original));
    try {
      gl = canvas.getContext('webgl', { alpha: false, antialias: false, depth: false, powerPreference: 'low-power' });
      if (!gl) throw new Error('WebGL unavailable');
      program = gl.createProgram();
      gl.attachShader(program, shader(gl.VERTEX_SHADER, 'attribute vec2 pos; varying vec2 uv; void main(){uv=(pos+1.0)*0.5; gl_Position=vec4(pos,0.,1.);}'));
      gl.attachShader(program, shader(gl.FRAGMENT_SHADER, `precision highp float;
        varying vec2 uv; uniform sampler2D original; uniform sampler2D soft;
        uniform float time; uniform mat3 palette; uniform mat3 basis;
        uniform vec2 resolution;
        uniform float grainAmount, noiseAmount, noisePixel;
        uniform float driftAmount, driftSpeed, smokeScale, softness;
        uniform float saturation, brightness, contrast;
        float hash(vec2 v){ return fract(sin(dot(v, vec2(127.1, 311.7))) * 43758.545); }
        vec3 sampleSoft(vec2 v){
          vec2 c = clamp(v, 0.0, 1.0);
          if (softness <= 0.0) return texture2D(soft, c).rgb;
          vec2 o = softness / resolution;
          vec3 acc = texture2D(soft, c).rgb * 0.36;
          acc += texture2D(soft, clamp(v + vec2(o.x, 0.0), 0.0, 1.0)).rgb * 0.16;
          acc += texture2D(soft, clamp(v - vec2(o.x, 0.0), 0.0, 1.0)).rgb * 0.16;
          acc += texture2D(soft, clamp(v + vec2(0.0, o.y), 0.0, 1.0)).rgb * 0.16;
          acc += texture2D(soft, clamp(v - vec2(0.0, o.y), 0.0, 1.0)).rgb * 0.16;
          return acc;
        }
        void main(){
          vec2 p=vec2(uv.x,1.0-uv.y);
          vec2 sp=smokeScale==1.0?p:(p-0.5)/smokeScale+0.5;
          float t=driftSpeed==1.0?time:time*driftSpeed;
          vec2 drift=vec2(sin(sp.y*7.0+t*.11)-sin(sp.y*7.0),sin(sp.x*6.0-t*.085)-sin(sp.x*6.0))*driftAmount;
          vec3 grain=texture2D(original,p).rgb-texture2D(soft,p).rgb;
          if(grainAmount!=1.0) grain*=grainAmount;
          vec3 col=palette*basis*sampleSoft(sp+drift);
          if(contrast!=1.0) col=(col-0.5)*contrast+0.5;
          if(brightness!=1.0) col*=brightness;
          if(saturation!=1.0) col=mix(vec3(dot(col,vec3(0.2126,0.7152,0.0722))),col,saturation);
          col+=grain;
          if(noiseAmount>0.0) col+=(hash(floor(gl_FragCoord.xy/max(noisePixel,1.0)))-0.5)*noiseAmount;
          gl_FragColor=vec4(clamp(col,0.0,1.0),1.0);
        }`));
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('Smoke shader linking failed');
      gl.useProgram(program);
      const buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
      const pos = gl.getAttribLocation(program, 'pos'); gl.enableVertexAttribArray(pos); gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);
      const images = await Promise.all(['smoke-grain.png', 'smoke-soft.png'].map(name => new Promise((resolve, reject) => {
        const img = new Image(); img.onload = () => resolve(img); img.onerror = reject; img.src = window.SmokeTextures[name];
      })));
      images.forEach((img, i) => {
        gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, img);
        gl.uniform1i(gl.getUniformLocation(program, i ? 'soft' : 'original'), i);
      });
      gl.uniformMatrix3fv(gl.getUniformLocation(program, 'basis'), false, referenceInverse);
      uniforms = Object.fromEntries([...Object.keys(defaults), 'resolution', 'palette', 'time']
        .map(name => [name, gl.getUniformLocation(program, name)]));
      pushParams();
      ready = true; canvas.dataset.renderer = 'webgl'; resize();
    } catch {
      gl = null; canvas.dataset.renderer = 'static-fallback';
      showStatic();
    }
  }
  function pushParams() {
    if (!gl || !uniforms) return;
    gl.useProgram(program);
    for (const key of Object.keys(defaults)) gl.uniform1f(uniforms[key], params[key]);
    gl.uniform2f(uniforms.resolution, canvas.width || 1, canvas.height || 1);
    lastDraw = -Infinity;
  }
  function resize() {
    // One physical pixel per CSS pixel; avoid multiplying fill cost on Retina.
    canvas.width = innerWidth; canvas.height = innerHeight;
    if (ready && gl) { gl.viewport(0, 0, canvas.width, canvas.height); pushParams(); }
    lastDraw = -Infinity;
  }
  function tick(now) {
    if (!ready || !gl || !current || now - lastDraw < 1000 / 30) return;
    const reduced = media.matches || capture;
    const changing = current.some((v, i) => Math.abs(v - target[i]) > .0001);
    if ((!moving || reduced) && !changing && lastDraw !== -Infinity) return;
    const delta = Number.isFinite(lastDraw) ? Math.min(now - lastDraw, 100) : 33;
    if (moving && !reduced) phase += delta / 1000;
    current = current.map((v, i) => reduced ? target[i] : v + (target[i] - v) * (1 - Math.exp(-delta / 500)));
    gl.useProgram(program);
    gl.uniformMatrix3fv(uniforms.palette, false, current);
    gl.uniform1f(uniforms.time, reduced ? 0 : phase);
    gl.drawArrays(gl.TRIANGLES, 0, 6); canvas.style.opacity = '1'; lastDraw = now;
  }
  canvas.addEventListener('webglcontextlost', event => {
    event.preventDefault(); ready = false; canvas.dataset.renderer = 'static-fallback';
    showStatic();
  });
  canvas.addEventListener('webglcontextrestored', () => { ready = false; init(); });
  addEventListener('resize', resize);
  media.addEventListener('change', () => { lastDraw = -Infinity; });
  window.Smoke = {
    init, readPalette, tick, defaults, params,
    setMotion(value) { if (moving !== value) { moving = value; lastDraw = -Infinity; } },
    reset() { phase = 0; lastDraw = -Infinity; },
    setParams(next) { Object.assign(params, next); pushParams(); },
  };
})();
