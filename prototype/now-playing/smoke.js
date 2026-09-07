/* 背景。4点の放射グラデーションをシェーダーで生成し、ノイズで歪ませて流す。
 *
 * 元になっているのは、ユーザーがグラデーション生成サイトで作った配色レシピ。
 * ジャケットからスポイトで拾った4色を、下記の位置に置いたもの。
 *
 *   background-color: #000F1D
 *   radial-gradient(at 20% 26%, #019E9E 0px, transparent 62%)
 *   radial-gradient(at 80% 22%, #2D4B4D 0px, transparent 62%)
 *   radial-gradient(at 72% 80%, #000F1D 0px, transparent 62%)
 *   radial-gradient(at 24% 76%, #AAB580 0px, transparent 62%)
 *   （Duotone / Grain / スケール 77% / ゆがみ 59%）
 *
 * 初版は、この配色で書き出した1枚のPNGを3x3の色行列で染め直していた。
 * それだと元の3色と大きく違うジャケットで色が破綻するため、レシピ自体を
 * 実装へ移した。色はパレットから来るので、どんなジャケットでも正しく生成される。
 * 副次的に、4.7MB の埋め込みテクスチャが不要になった。
 *
 * スポットの位置は配色ではなく構図なので、曲が変わっても動かさない。変わるのは色だけ。
 * WebGL が使えない場合は、style.css の body に置いた同じレシピの静的版が出る。 */
(() => {
  const canvas = document.querySelector('#smoke');
  const capture = new URLSearchParams(location.search).get('capture') === '1';
  const media = matchMedia('(prefers-reduced-motion: reduce)');

  // 構図。**ここが唯一の正本。** シェーダーへは uniform で渡し、
  // WebGL 不可時の静的版（style.css の body）へは CSS カスタムプロパティで渡す。
  // 以前は GLSL へ直書きしていて、この配列を変えても絵が変わらなかった。
  const SPOTS = [[.20, .26], [.80, .22], [.72, .80], [.24, .76]];
  const COLOR_KEYS = ['base', 'spot0', 'spot1', 'spot2', 'spot3'];

  // 調整パネル（tune.js）から setParams() で上書きされる。
  const defaults = {
    warpAmount: .24, warpScale: 2.0, warpSpeed: 5, cloudAmount: .22,
    spotRadius: .62, fieldScale: 1.08,
    grainAmount: .05, noisePixel: 2,
    saturation: 1, brightness: 1, contrast: 1,
  };
  const params = { ...defaults };

  let gl, program, uniforms = null, ready = false;
  let moving = true, lastDraw = -Infinity, phase = 0;
  let target, current;

  // パレットに色が足りなくても、例外で Now Playing の初期化ごと止めない。
  // 本番では抽出処理の不具合や未知のジャケットで欠けうるため。
  const FALLBACK = '#101418';
  function rgb(value, key) {
    const hex = String(value ?? '').trim().replace('#', '');
    if (!/^[0-9a-f]{6}$/i.test(hex)) {
      console.warn(`[smoke] --art-${key} が読めません（値: ${JSON.stringify(value)}）。既定色で代替します。`);
      return rgb(FALLBACK, key);
    }
    return hex.match(/../g).map(v => parseInt(v, 16) / 255);
  }

  function readPalette() {
    const style = getComputedStyle(document.documentElement);
    target = COLOR_KEYS.flatMap(key => rgb(style.getPropertyValue(`--art-${key}`), key));
    if (!current) current = target.slice();
    lastDraw = -Infinity;
  }

  // 静的版（style.css の body）へ構図を渡す。SPOTS を二重管理しないため。
  SPOTS.forEach(([x, y], i) => {
    document.documentElement.style.setProperty(`--spot${i}-x`, `${x * 100}%`);
    document.documentElement.style.setProperty(`--spot${i}-y`, `${y * 100}%`);
  });

  function shader(kind, source) {
    const s = gl.createShader(kind); gl.shaderSource(s, source); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('Smoke shader compilation failed');
    return s;
  }

  const FRAGMENT = `precision highp float;
    varying vec2 uv;
    uniform vec3 base, spot0, spot1, spot2, spot3;
    uniform vec2 spotPos0, spotPos1, spotPos2, spotPos3;
    uniform float time, warpAmount, warpScale, warpSpeed, cloudAmount;
    uniform float spotRadius, fieldScale, grainAmount, noisePixel;
    uniform float saturation, brightness, contrast;
    float hash21(vec2 p){
      vec3 v = fract(vec3(p.xyx) * 0.1031);
      v += dot(v, v.yzx + 33.33);
      return fract((v.x + v.y) * v.z);
    }
    float vnoise(vec2 p){
      vec2 i = floor(p), f = fract(p);
      f = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x),
                 mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), f.x), f.y);
    }
    float fbm(vec2 p){
      float v = 0.0, a = 0.5;
      for (int i = 0; i < 4; i++) { v += a * vnoise(p); p *= 2.03; a *= 0.5; }
      return v;
    }
    // CSS の "COLOR 0px, transparent 62%" と同じ、中心から線形に消える重み。
    float weight(vec2 q, vec2 c){
      return clamp(1.0 - length(q - c) / max(spotRadius, 0.001), 0.0, 1.0);
    }
    void main(){
      vec2 p = vec2(uv.x, 1.0 - uv.y);
      vec2 q = p;
      float t = time * warpSpeed;
      if (warpAmount > 0.0) {
        q += (vec2(fbm(p * warpScale + vec2(0.0, t * 0.05)),
                   fbm(p * warpScale + vec2(4.7, -t * 0.043))) - 0.5) * warpAmount;
      }
      if (fieldScale != 1.0) q = (q - 0.5) / fieldScale + 0.5;
      // CSS の background-image は先頭が最前面。奥から順に重ねる。
      vec3 col = base;
      col = mix(col, spot3, weight(q, spotPos3));
      col = mix(col, spot2, weight(q, spotPos2));
      col = mix(col, spot1, weight(q, spotPos1));
      col = mix(col, spot0, weight(q, spotPos0));
      // 濃淡。グラデーションを歪ませるだけだと平坦になるので、雲の陰影を重ねる。
      if (cloudAmount > 0.0) {
        float n = fbm(q * warpScale * 1.7 + vec2(t * 0.028, -t * 0.021));
        col *= 1.0 + (n - 0.5) * cloudAmount * 2.0;
      }
      if (contrast != 1.0) col = (col - 0.5) * contrast + 0.5;
      if (brightness != 1.0) col *= brightness;
      if (saturation != 1.0) col = mix(vec3(dot(col, vec3(0.2126, 0.7152, 0.0722))), col, saturation);
      if (grainAmount > 0.0) col += (hash21(floor(gl_FragCoord.xy / max(noisePixel, 1.0))) - 0.5) * grainAmount;
      gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
    }`;

  function init() {
    try {
      gl = canvas.getContext('webgl', { alpha: false, antialias: false, depth: false, powerPreference: 'low-power' });
      if (!gl) throw new Error('WebGL unavailable');
      program = gl.createProgram();
      gl.attachShader(program, shader(gl.VERTEX_SHADER,
        'attribute vec2 pos; varying vec2 uv; void main(){uv=(pos+1.0)*0.5; gl_Position=vec4(pos,0.,1.);}'));
      gl.attachShader(program, shader(gl.FRAGMENT_SHADER, FRAGMENT));
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('Smoke shader linking failed');
      gl.useProgram(program);
      const buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
      const pos = gl.getAttribLocation(program, 'pos');
      gl.enableVertexAttribArray(pos); gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);
      uniforms = Object.fromEntries([...Object.keys(defaults), ...COLOR_KEYS, 'time']
        .map(name => [name, gl.getUniformLocation(program, name)]));
      SPOTS.forEach(([x, y], i) => gl.uniform2f(gl.getUniformLocation(program, `spotPos${i}`), x, y));
      pushParams();
      ready = true; canvas.dataset.renderer = 'webgl'; resize();
    } catch {
      // style.css の body に同じレシピの静的版があるので、canvas を消すだけでよい。
      gl = null; ready = false; canvas.dataset.renderer = 'static-fallback';
      canvas.style.opacity = '0';
    }
  }

  function pushParams() {
    if (!gl || !uniforms) return;
    gl.useProgram(program);
    for (const key of Object.keys(defaults)) gl.uniform1f(uniforms[key], params[key]);
    lastDraw = -Infinity;
  }

  function resize() {
    // One physical pixel per CSS pixel; avoid multiplying fill cost on Retina.
    canvas.width = innerWidth; canvas.height = innerHeight;
    if (ready && gl) gl.viewport(0, 0, canvas.width, canvas.height);
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
    COLOR_KEYS.forEach((key, i) => gl.uniform3f(uniforms[key], current[i * 3], current[i * 3 + 1], current[i * 3 + 2]));
    gl.uniform1f(uniforms.time, reduced ? 0 : phase);
    gl.drawArrays(gl.TRIANGLES, 0, 6); canvas.style.opacity = '1'; lastDraw = now;
  }

  canvas.addEventListener('webglcontextlost', event => {
    event.preventDefault(); ready = false;
    canvas.dataset.renderer = 'static-fallback'; canvas.style.opacity = '0';
  });
  canvas.addEventListener('webglcontextrestored', () => { ready = false; init(); });
  addEventListener('resize', resize);
  media.addEventListener('change', () => { lastDraw = -Infinity; });

  window.Smoke = {
    init, readPalette, tick, defaults, params, SPOTS,
    setMotion(value) { if (moving !== value) { moving = value; lastDraw = -Infinity; } },
    reset() { phase = 0; lastDraw = -Infinity; },
    setParams(next) { Object.assign(params, next); pushParams(); },
  };
})();
