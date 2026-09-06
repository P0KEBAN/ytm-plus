/* 調整用パネル。プロトタイプ専用で、拡張本体へは持ち込まない。
 *
 * 目的は「AIと言葉でラリーせずに、人間がスライダーで決めた数値を1回で渡す」こと。
 * ?tune=1 を付けて開くか、Shift+T で出る。既定値のままなら見た目は一切変わらない。
 * 決まったら「数値を書き出す」でテキストを取り出し、それをAIへ渡して既定値へ焼き込む。
 *
 * 値は localStorage に残る。パネルを有効にするまでは何も適用しない
 * （通常表示のプロトタイプが調整値で汚れないようにするため）。 */
(() => {
  const STORE = 'ytm-plus.tune';

  // shader 側（smoke.js の defaults と対応）
  const SMOKE = [
    { key: 'grainAmount', label: 'PSD由来の粒の強さ', min: 0, max: 2, step: .05 },
    { key: 'noiseAmount', label: '追加ノイズの強さ', min: 0, max: .2, step: .005 },
    { key: 'noisePixel', label: '追加ノイズの粒の大きさ(px)', min: 1, max: 8, step: 1 },
    { key: 'driftAmount', label: 'うねりの大きさ', min: 0, max: .05, step: .001, group: '煙' },
    { key: 'driftSpeed', label: '動きの速さ（倍率）', min: 0, max: 8, step: .05 },
    { key: 'smokeScale', label: '模様の拡大率', min: .6, max: 2, step: .01 },
    { key: 'softness', label: '追加のぼかし', min: 0, max: 4, step: .1 },
    { key: 'saturation', label: '彩度', min: 0, max: 2, step: .02 },
    { key: 'brightness', label: '明るさ', min: .6, max: 1.4, step: .01 },
    { key: 'contrast', label: 'コントラスト', min: .6, max: 1.4, step: .01 },
  ];

  // CSS カスタムプロパティ側
  const CSS = [
    { key: '--sw-bg', label: '背景の不透明度', min: 0, max: 1, step: .02, value: .16 },
    { key: '--sw-sel', label: '選択部の不透明度', min: 0, max: 1, step: .02, value: .18 },
    { key: '--sw-blur', label: '背景のぼかし', min: 0, max: 24, step: 1, value: 5, unit: 'px' },
    { key: '--sw-radius', label: '外側の角丸', min: 0, max: 48, step: 1, value: 36, unit: 'px' },
    { key: '--sw-btn-radius', label: '選択部の角丸', min: 0, max: 36, step: 1, value: 25, unit: 'px' },
    { key: '--sw-h', label: '高さ', min: 36, max: 76, step: 1, value: 56, unit: 'px' },
    { key: '--sw-w', label: '幅', min: 100, max: 220, step: 1, value: 151, unit: 'px' },
    { key: '--sw-pad', label: '内側の余白', min: 0, max: 10, step: 1, value: 5, unit: 'px' },
  ];

  const TINTS = [
    { label: 'グレー（モックのまま）', value: '196 196 196' },
    { label: '白', value: '255 255 255' },
    { label: '黒', value: '0 0 0' },
  ];

  const cssDefaults = Object.fromEntries(CSS.map(c => [c.key, c.value]));
  const state = { ...cssDefaults, '--sw-tint': TINTS[0].value };
  let panel = null, active = false;

  function smokeDefaults() { return window.Smoke ? window.Smoke.defaults : {}; }

  function load() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORE) || '{}');
      Object.assign(state, saved);
    } catch { /* 壊れていたら既定値のまま進める */ }
  }
  function save() {
    try { localStorage.setItem(STORE, JSON.stringify(state)); } catch { /* 保存できなくても動作は続ける */ }
  }

  function apply() {
    const smoke = {};
    for (const item of SMOKE) if (item.key in state) smoke[item.key] = state[item.key];
    if (window.Smoke) window.Smoke.setParams(smoke);
    for (const item of CSS) {
      document.documentElement.style.setProperty(item.key, state[item.key] + (item.unit || ''));
    }
    document.documentElement.style.setProperty('--sw-tint', state['--sw-tint']);
  }

  function clearApplied() {
    if (window.Smoke) window.Smoke.setParams({ ...smokeDefaults() });
    for (const item of CSS) document.documentElement.style.removeProperty(item.key);
    document.documentElement.style.removeProperty('--sw-tint');
  }

  function changed() {
    const out = { smoke: {}, css: {} };
    const sd = smokeDefaults();
    for (const item of SMOKE) {
      const v = state[item.key] ?? sd[item.key];
      if (Math.abs(v - sd[item.key]) > 1e-9) out.smoke[item.key] = v;
    }
    for (const item of CSS) if (state[item.key] !== item.value) out.css[item.key] = state[item.key] + (item.unit || '');
    // side はパネルの置き場所であって、デザインの値ではない
    if (state['--sw-tint'] !== TINTS[0].value) out.css['--sw-tint'] = state['--sw-tint'];
    return out;
  }

  function exportText() {
    const { smoke, css } = changed();
    const lines = ['# ytm-plus プロトタイプ 調整値', ''];
    if (!Object.keys(smoke).length && !Object.keys(css).length) {
      lines.push('（すべて既定値のままです）');
    } else {
      if (Object.keys(smoke).length) {
        lines.push('## 背景（smoke.js の defaults を書き換える）');
        for (const [k, v] of Object.entries(smoke)) lines.push(`${k}: ${v}`);
        lines.push('');
      }
      if (Object.keys(css).length) {
        lines.push('## 右下の切替（style.css の .view-switch を書き換える）');
        for (const [k, v] of Object.entries(css)) lines.push(`${k}: ${v}`);
        lines.push('');
      }
      lines.push('※ 既定値のままの項目は省略しています。');
    }
    return lines.join('\n');
  }

  function row(item, current, onInput) {
    const wrap = document.createElement('label');
    wrap.className = 'tune-row';
    const head = document.createElement('span');
    const name = document.createElement('span'); name.textContent = item.label;
    const out = document.createElement('output'); out.textContent = current;
    head.append(name, out);
    const input = document.createElement('input');
    Object.assign(input, { type: 'range', min: item.min, max: item.max, step: item.step, value: current });
    input.addEventListener('input', () => { out.textContent = input.value; onInput(Number(input.value)); });
    wrap.append(head, input);
    return { wrap, input, out };
  }

  function build() {
    panel = document.createElement('aside');
    panel.id = 'tune-panel';
    panel.setAttribute('aria-label', '調整パネル（プロトタイプ専用）');

    const style = document.createElement('style');
    style.textContent = `
      #tune-panel { position: fixed; left: 16px; top: 16px; z-index: 9999; width: 306px;
        transition: left .15s, right .15s; }
      #tune-panel.right { left: auto; right: 16px; }
      #tune-panel {
        max-height: calc(100vh - 32px); overflow: auto; padding: 14px 14px 16px;
        border-radius: 14px; background: #0d1418f2; color: #dce6ea; backdrop-filter: blur(14px);
        box-shadow: 0 12px 40px #0009; font: 12px/1.45 system-ui, sans-serif; }
      #tune-panel h2 { margin: 0 0 2px; font-size: 13px; letter-spacing: .04em; }
      #tune-panel .hint { margin: 0 0 12px; color: #8fa3ac; font-size: 11px; }
      #tune-panel h3 { margin: 14px 0 6px; font-size: 11px; color: #7fd4c4; letter-spacing: .08em; }
      #tune-panel .tune-row { display: block; margin-bottom: 9px; }
      #tune-panel .tune-row > span { display: flex; justify-content: space-between; gap: 8px; margin-bottom: 3px; }
      #tune-panel output { color: #9fe8d6; font-variant-numeric: tabular-nums; }
      #tune-panel input[type=range] { width: 100%; margin: 0; accent-color: #4fd1b5; }
      #tune-panel select { width: 100%; margin-bottom: 8px; background: #16232a; color: inherit;
        border: 1px solid #2b3d45; border-radius: 7px; padding: 4px 6px; font: inherit; }
      #tune-panel .tune-buttons { display: flex; gap: 6px; margin-top: 14px; }
      #tune-panel button { flex: 1; padding: 7px 4px; border: 1px solid #2b3d45; border-radius: 8px;
        background: #16232a; color: inherit; font: inherit; cursor: pointer; }
      #tune-panel button:hover { background: #1e2f38; }
      #tune-panel textarea { width: 100%; height: 150px; margin-top: 10px; padding: 8px;
        background: #060b0e; color: #cfe6dd; border: 1px solid #2b3d45; border-radius: 8px;
        font: 11px/1.5 ui-monospace, monospace; resize: vertical; }
      #tune-panel .copied { margin: 6px 0 0; color: #7fd4c4; font-size: 11px; }
    `;
    panel.append(style);

    const title = document.createElement('h2'); title.textContent = '調整パネル';
    const hint = document.createElement('p'); hint.className = 'hint';
    hint.textContent = 'Shift+T で開閉。値は自動保存されます。決まったら「数値を書き出す」の内容をAIへ渡してください。';
    panel.append(title, hint);

    const sd = smokeDefaults();
    let heading = document.createElement('h3'); heading.textContent = '背景の粒（ザラザラ）';
    panel.append(heading);
    const inputs = [];
    for (const item of SMOKE) {
      if (item.group === '煙') {
        heading = document.createElement('h3'); heading.textContent = '背景の煙';
        panel.append(heading);
      }
      const current = state[item.key] ?? sd[item.key];
      const r = row(item, current, v => { state[item.key] = v; save(); apply(); });
      inputs.push({ item, ...r, fallback: () => sd[item.key] });
      panel.append(r.wrap);
    }

    heading = document.createElement('h3'); heading.textContent = '右下の切替';
    panel.append(heading);
    const tint = document.createElement('select');
    tint.setAttribute('aria-label', '切替の色');
    for (const t of TINTS) { const o = document.createElement('option'); o.value = t.value; o.textContent = t.label; tint.append(o); }
    tint.value = state['--sw-tint'];
    tint.addEventListener('change', () => { state['--sw-tint'] = tint.value; save(); apply(); });
    panel.append(tint);
    for (const item of CSS) {
      const r = row(item, state[item.key], v => { state[item.key] = v; save(); apply(); });
      inputs.push({ item, ...r, fallback: () => item.value });
      panel.append(r.wrap);
    }

    const buttons = document.createElement('div'); buttons.className = 'tune-buttons';
    const exportBtn = document.createElement('button'); exportBtn.type = 'button'; exportBtn.textContent = '数値を書き出す';
    const resetBtn = document.createElement('button'); resetBtn.type = 'button'; resetBtn.textContent = '初期値に戻す';
    const sideBtn = document.createElement('button'); sideBtn.type = 'button'; sideBtn.textContent = '左右';
    sideBtn.title = 'パネルを反対側へ移す（隠れている部分を見たいとき）';
    const closeBtn = document.createElement('button'); closeBtn.type = 'button'; closeBtn.textContent = '閉じる';
    buttons.append(exportBtn, resetBtn, sideBtn, closeBtn);
    panel.append(buttons);

    const box = document.createElement('textarea'); box.readOnly = true; box.hidden = true;
    box.setAttribute('aria-label', '書き出した調整値');
    const note = document.createElement('p'); note.className = 'copied'; note.hidden = true;
    panel.append(box, note);

    exportBtn.addEventListener('click', async () => {
      box.hidden = false; box.value = exportText(); box.select();
      note.hidden = false;
      try { await navigator.clipboard.writeText(box.value); note.textContent = 'クリップボードにコピーしました。'; }
      catch { note.textContent = '選択済みです。手動でコピーしてください。'; }
    });
    resetBtn.addEventListener('click', () => {
      for (const item of SMOKE) delete state[item.key];
      for (const item of CSS) state[item.key] = item.value;
      state['--sw-tint'] = TINTS[0].value;
      save(); clearApplied(); apply();
      for (const entry of inputs) {
        const v = state[entry.item.key] ?? entry.fallback();
        entry.input.value = v; entry.out.textContent = v;
      }
      tint.value = state['--sw-tint'];
      box.hidden = true; note.hidden = true;
    });
    sideBtn.addEventListener('click', () => {
      state.side = panel.classList.toggle('right') ? 'right' : 'left';
      save();
    });
    if (state.side === 'right') panel.classList.add('right');
    closeBtn.addEventListener('click', () => toggle(false));

    document.body.append(panel);
  }

  function toggle(next) {
    active = next ?? !active;
    if (active) {
      if (!panel) { load(); build(); }
      panel.hidden = false;
      apply();
    } else if (panel) {
      panel.hidden = true;
      clearApplied();
    }
  }

  addEventListener('keydown', event => {
    if (!event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key !== 'T' && event.key !== 't') return;
    if (event.target instanceof HTMLTextAreaElement) return;
    event.preventDefault();
    toggle();
  });

  if (new URLSearchParams(location.search).get('tune') === '1') {
    if (document.readyState === 'loading') addEventListener('DOMContentLoaded', () => toggle(true));
    else toggle(true);
  }
})();
