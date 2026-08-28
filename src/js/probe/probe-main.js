// ============================================================================
// ytm-plus Phase 4a / 4b 検証プローブ（一時ファイル・MAIN world）
//
// manifest で world:"MAIN" 指定。ページ側の JS コンテキストで動くため、
// Polymer / YT Player の内部APIに触れられる。ここでは読み取りのみ行い、
// 再生状態を変える呼び出し（setVolume など）は一切しない。
//
// isolated world 側（probe-isolated.js）からの postMessage に応答する。
// ============================================================================
(() => {
  'use strict';

  // 名前から用途を推測せず、実在するプロパティを機械的に洗い出す。
  const KEYWORD = /volume|shuffle|repeat|loop|queue|next|previous|prev|play|pause|seek|store|mute/i;

  const inspect = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return { found: false };
    const props = [];
    let o = el;
    let depth = 0;
    while (o && depth < 8) {
      for (const k of Object.getOwnPropertyNames(o)) {
        if (!KEYWORD.test(k)) continue;
        let kind = 'unknown';
        try {
          const d = Object.getOwnPropertyDescriptor(o, k);
          if (d && typeof d.get === 'function') kind = 'getter';
          else if (d && typeof d.value === 'function') kind = 'function';
          else if (d) kind = typeof d.value;
        } catch (_) { /* アクセスで例外を出すプロパティは種別不明のまま扱う */ }
        props.push({ name: k, kind, depth });
      }
      o = Object.getPrototypeOf(o);
      depth++;
    }
    const seen = new Set();
    const uniq = props.filter((p) => (seen.has(p.name) ? false : (seen.add(p.name), true)));
    return { found: true, tag: el.tagName.toLowerCase(), props: uniq.slice(0, 80) };
  };

  // #movie_player の公開APIは呼び出しても安全な getter 系だけ試す
  const readMoviePlayer = () => {
    const p = document.querySelector('#movie_player');
    if (!p) return { found: false };
    const out = { found: true, calls: {} };
    for (const m of ['getVolume', 'isMuted', 'getPlayerState', 'getCurrentTime', 'getDuration']) {
      try { out.calls[m] = typeof p[m] === 'function' ? p[m]() : '(関数でない)'; }
      catch (e) { out.calls[m] = 'ERR: ' + String(e && e.message || e); }
    }
    out.hasSetVolume = typeof p.setVolume === 'function';
    out.hasNextVideo = typeof p.nextVideo === 'function';
    out.hasPreviousVideo = typeof p.previousVideo === 'function';
    return out;
  };

  // ytmusic-app の Redux ストア（あればシャッフル/リピート状態の正本になりうる）
  const readStore = () => {
    const app = document.querySelector('ytmusic-app');
    if (!app) return { found: false };
    const store = app.store || app._store || (app.$ && app.$.store) || null;
    if (!store || typeof store.getState !== 'function') {
      return { found: true, storeAvailable: false, appKeys: Object.getOwnPropertyNames(app).slice(0, 40) };
    }
    let state = null;
    try { state = store.getState(); } catch (e) { return { found: true, storeAvailable: true, error: String(e) }; }
    const out = { found: true, storeAvailable: true, topLevelKeys: Object.keys(state || {}) };
    if (state && state.queue) {
      out.queueKeys = Object.keys(state.queue);
      out.queueRepeatMode = state.queue.repeatMode ?? null;
      out.queueShuffleEnabled = state.queue.shuffleEnabled ?? null;
      out.queueItemCount = Array.isArray(state.queue.items) ? state.queue.items.length : null;
    }
    return out;
  };

  const scan = () => ({
    ok: true,
    world: 'MAIN',
    ts: new Date().toISOString(),
    playerBar: inspect('ytmusic-player-bar'),
    app: inspect('ytmusic-app'),
    player: inspect('ytmusic-player'),
    moviePlayer: readMoviePlayer(),
    store: readStore(),
  });

  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.source !== 'ytmplus-probe-isolated' || d.cmd !== 'scan') return;
    let payload;
    try { payload = scan(); }
    catch (e) { payload = { ok: false, error: String(e && e.stack || e) }; }
    window.postMessage({ source: 'ytmplus-probe-main', payload }, '*');
  });
})();
