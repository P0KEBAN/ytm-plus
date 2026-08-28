// ============================================================================
// ytm-plus Phase 4a / 4b 検証プローブ（一時ファイル・判定後に削除する）
//
// 目的:
//   4a 新UIの読み込み方式を、推測ではなく実機の挙動で決める
//   4b 再生制御（音量/シャッフル/リピート）に使えるAPIを実機で洗い出す
//
// 使い方:
//   1. chrome://extensions でリロード（↻）
//   2. music.youtube.com を開いて曲を再生する
//   3. F12 → Console。10秒ほどで [YTMPLUS-PROBE] のレポートが出る
//   4. 最後の 1 行（[YTMPLUS-PROBE-JSON] ...）をコピーして AI に渡す
//
// このファイルはトップレベル宣言を一切持たない（IIFE のみ）。
// 既存の 325 個のグローバル束縛と衝突しないことが前提。
// ============================================================================
(() => {
  'use strict';

  const TAG = '[YTMPLUS-PROBE]';
  const R = {
    ts: new Date().toISOString(),
    chromeVersion: (navigator.userAgent.match(/Chrome\/([\d.]+)/) || [])[1] || null,
  };

  // ---------------------------------------------------------------------
  // 検証A: 別の content_scripts エントリでもグローバルスコープを共有するか
  //   共有していれば、新UIを平置きで足すたびに 325 個の名前と衝突しうる。
  //   typeof は未宣言の識別子でも例外を投げないので、既存コードを壊さない。
  // ---------------------------------------------------------------------
  R.sharedScope = {
    config: typeof config !== 'undefined',
    ui: typeof ui !== 'undefined',
    storage: typeof storage !== 'undefined',
    createEl: typeof createEl !== 'undefined',
    YTMLog: typeof YTMLog !== 'undefined',
    CloudSync: typeof CloudSync !== 'undefined',
    PipManager: typeof PipManager !== 'undefined',
    QueueManager: typeof QueueManager !== 'undefined',
    ReplayManager: typeof ReplayManager !== 'undefined',
  };
  R.sharedScopeVerdict =
    Object.values(R.sharedScope).filter(Boolean).length + '/' + Object.keys(R.sharedScope).length;

  // ---------------------------------------------------------------------
  // 検証B: 名前空間オブジェクト方式が content script 間で成立するか
  //   このファイルで window に生やし、probe-isolated-2.js から読めるかを見る。
  //   （結果は 2 側が書き込む）
  // ---------------------------------------------------------------------
  window.__YTMPLUS_PROBE__ = { createdBy: 'probe-isolated.js', value: 42 };

  // ---------------------------------------------------------------------
  // 検証E: 再生制御で使う DOM セレクタの実在確認（言語非依存かどうか）
  // ---------------------------------------------------------------------
  const has = (sel) => !!document.querySelector(sel);
  const collectSelectors = () => {
    R.selectors = {
      'ytmusic-player-bar': has('ytmusic-player-bar'),
      'ytmusic-player-bar .previous-button': has('ytmusic-player-bar .previous-button'),
      'ytmusic-player-bar .next-button': has('ytmusic-player-bar .next-button'),
      'ytmusic-player-bar #play-pause-button': has('ytmusic-player-bar #play-pause-button'),
      'ytmusic-player-bar .play-pause-button': has('ytmusic-player-bar .play-pause-button'),
      'ytmusic-app': has('ytmusic-app'),
      '#movie_player': has('#movie_player'),
      'video': has('video'),
    };
    // プレイヤーバー内のボタンを aria-label ではなく安定した属性で拾えるか
    const bar = document.querySelector('ytmusic-player-bar');
    R.playerBarButtons = bar
      ? Array.from(bar.querySelectorAll('tp-yt-paper-icon-button, button'))
          .slice(0, 40)
          .map((el) => ({
            tag: el.tagName.toLowerCase(),
            id: el.id || null,
            cls: (typeof el.className === 'string' ? el.className : '').slice(0, 80) || null,
            title: el.getAttribute('title') || null,
            aria: el.getAttribute('aria-label') || null,
            parentCls: (el.parentElement && typeof el.parentElement.className === 'string'
              ? el.parentElement.className : '').slice(0, 60) || null,
          }))
      : [];
  };

  // ---------------------------------------------------------------------
  // 検証F: isolated world から Polymer のプロパティが見えるか
  //   見えなければ、shuffle / repeat は MAIN world 経由が必須になる。
  // ---------------------------------------------------------------------
  const probeProps = (el) => {
    if (!el) return null;
    const out = [];
    let o = el;
    let depth = 0;
    while (o && depth < 6) {
      for (const k of Object.getOwnPropertyNames(o)) {
        if (/volume|shuffle|repeat|queue|store|playerApi|nextVideo|previousVideo/i.test(k)) out.push(k);
      }
      o = Object.getPrototypeOf(o);
      depth++;
    }
    return Array.from(new Set(out)).slice(0, 60);
  };
  const collectIsolatedPolymerProps = () => {
    R.isolatedPolymerProps = {
      'ytmusic-player-bar': probeProps(document.querySelector('ytmusic-player-bar')),
      'ytmusic-app': probeProps(document.querySelector('ytmusic-app')),
      '#movie_player': probeProps(document.querySelector('#movie_player')),
    };
  };


  // ---------------------------------------------------------------------
  // 検証G(4b): シャッフル / リピート / 音量ボタンの DOM 構造
  //   aria-label はローカライズされる（実測で「リピートオフ」だった）。
  //   icon 名や aria-pressed のような言語非依存の手掛かりがあるかを見る。
  // ---------------------------------------------------------------------
  const collectControlDom = () => {
    const dump = (sel) => Array.from(document.querySelectorAll(sel)).map((el, i) => {
      const btn = el.querySelector('button') || el.querySelector('tp-yt-paper-icon-button') || el;
      const icons = Array.from(el.querySelectorAll('yt-icon, iron-icon'))
        .map((ic) => ic.getAttribute('icon') || (ic.icon != null ? String(ic.icon) : null));
      return {
        nth: i,
        visible: !!el.offsetParent,
        cls: typeof el.className === 'string' ? el.className : null,
        aria: btn.getAttribute('aria-label'),
        ariaPressed: btn.getAttribute('aria-pressed'),
        title: btn.getAttribute('title'),
        icons,
        html: el.outerHTML.replace(/\s+/g, ' ').slice(0, 700),
      };
    });
    R.controlDom = {
      repeat: dump('ytmusic-player-bar .repeat'),
      shuffle: dump('ytmusic-player-bar .shuffle, ytmusic-player-bar .expand-shuffle'),
      volume: dump('ytmusic-player-bar .volume, ytmusic-player-bar .expand-volume'),
    };
    const v = document.querySelector('video');
    R.videoState = v ? { volume: v.volume, muted: v.muted, paused: v.paused, readyState: v.readyState } : null;
  };

  // ---------------------------------------------------------------------
  // 検証C: 動的 import() で ES モジュールを読み込めるか
  //   これが通れば、新UIは完全に独立したスコープを持てる（平置きの衝突が消える）。
  // ---------------------------------------------------------------------
  const testDynamicImport = async () => {
    const url = chrome.runtime.getURL('src/js/probe/probe-module.js');
    const t0 = performance.now();
    try {
      const mod = await import(url);
      const elapsed = Math.round(performance.now() - t0);
      const info = await mod.report();
      return {
        ok: true,
        elapsedMs: elapsed,
        url,
        // モジュール側の `const config` がグローバルの config を壊していないか
        globalConfigStillIntact: R.sharedScope.config === (typeof config !== 'undefined'),
        module: info,
      };
    } catch (e) {
      return { ok: false, url, error: String(e && e.message || e), name: e && e.name };
    }
  };

  // ---------------------------------------------------------------------
  // 検証D: MAIN world からの報告を受け取る
  // ---------------------------------------------------------------------
  const askMainWorld = () =>
    new Promise((resolve) => {
      let done = false;
      const onMsg = (ev) => {
        if (ev.source !== window) return;
        const d = ev.data;
        if (!d || d.source !== 'ytmplus-probe-main' || d.cmd !== 'scan') return;
        done = true;
        window.removeEventListener('message', onMsg);
        resolve(d.payload);
      };
      window.addEventListener('message', onMsg);
      const ping = () => window.postMessage({ source: 'ytmplus-probe-isolated', cmd: 'scan' }, '*');
      ping();
      setTimeout(ping, 1500);
      setTimeout(() => {
        if (done) return;
        window.removeEventListener('message', onMsg);
        resolve({ ok: false, error: 'MAIN world から応答なし（world:"MAIN" が効いていない可能性）' });
      }, 5000);
    });


  // ---------------------------------------------------------------------
  // 検証H(4b): 実際に操作したときに、どの読み取り経路が追従するか
  //   合成クリックはしない。ユーザーがYTMの本物のボタンを押す。
  //   （シャッフルを合成で往復させるとキュー順が戻らないため）
  // ---------------------------------------------------------------------
  const readIsolatedState = () => {
    const v = document.querySelector('video');
    const btn = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const b = el.querySelector('button') || el;
      const ic = el.querySelector('yt-icon, iron-icon');
      return [b.getAttribute('aria-label'), b.getAttribute('aria-pressed'),
              ic ? (ic.getAttribute('icon') || (ic.icon != null ? String(ic.icon) : null)) : null].join('|');
    };
    return {
      videoVolume: v ? Math.round(v.volume * 1000) / 1000 : null,
      videoMuted: v ? v.muted : null,
      videoPaused: v ? v.paused : null,
      repeatBtn: btn('ytmusic-player-bar .repeat'),
      shuffleBtn: btn('ytmusic-player-bar .shuffle'),
    };
  };

  const watch = (seconds) => new Promise((resolve) => {
    const snapshots = [];
    let last = '';
    const onMsg = (ev) => {
      if (ev.source !== window) return;
      const d = ev.data;
      if (!d || d.source !== 'ytmplus-probe-main' || d.cmd !== 'state') return;
      const snap = { t: Math.round(performance.now()), main: d.payload, iso: readIsolatedState() };
      const key = JSON.stringify([snap.main, snap.iso]);
      if (key === last) return;
      last = key;
      snapshots.push(snap);
      console.log(TAG + ' 状態が変化 #' + snapshots.length, snap);
    };
    window.addEventListener('message', onMsg);
    const timer = setInterval(
      () => window.postMessage({ source: 'ytmplus-probe-isolated', cmd: 'state' }, '*'), 400);
    setTimeout(() => {
      clearInterval(timer);
      window.removeEventListener('message', onMsg);
      resolve(snapshots);
    }, seconds * 1000);
  });

  const render = () => {
    console.log('%c' + TAG + ' Phase 4a/4b 検証レポート', 'font-weight:bold;font-size:14px');

    console.groupCollapsed(TAG + ' A. グローバルスコープ共有 → ' + R.sharedScopeVerdict + ' 件が見えている');
    console.table(R.sharedScope);
    console.log('別の content_scripts エントリからでも既存の束縛が見える = スコープは1つ。'
      + '平置きで新UIを足すと 325 個の名前と衝突しうる。');
    console.groupEnd();

    console.groupCollapsed(TAG + ' B. 名前空間オブジェクト方式 → ' + (R.namespace && R.namespace.ok ? 'OK' : 'NG'));
    console.log(R.namespace);
    console.groupEnd();

    console.groupCollapsed(TAG + ' C. 動的 import() → ' + (R.dynamicImport.ok ? 'OK (' + R.dynamicImport.elapsedMs + 'ms)' : 'NG'));
    console.log(R.dynamicImport);
    console.groupEnd();

    console.groupCollapsed(TAG + ' D. MAIN world / Polymer API → ' + (R.mainWorld && R.mainWorld.ok ? 'OK' : 'NG'));
    console.log(R.mainWorld);
    console.groupEnd();

    console.groupCollapsed(TAG + ' E. 再生制御セレクタの実在');
    console.table(R.selectors);
    console.table(R.playerBarButtons);
    console.groupEnd();

    console.groupCollapsed(TAG + ' G. シャッフル/リピート/音量ボタンの DOM 構造');
    console.log(R.controlDom, R.videoState);
    console.groupEnd();

    console.groupCollapsed(TAG + ' F. isolated world から見える Polymer プロパティ');
    console.log(R.isolatedPolymerProps);
    console.groupEnd();

    console.log('%c' + TAG + ' 下の 1 行をコピーして AI に渡してください', 'color:#0a0');
    console.log('[YTMPLUS-PROBE-JSON] ' + JSON.stringify(R));
  };

  // YTM の描画が落ち着くのを待ってから走らせる
  setTimeout(async () => {
    collectSelectors();
    collectIsolatedPolymerProps();
    collectControlDom();
    R.namespace = (window.__YTMPLUS_PROBE_2__ || { ok: false, error: 'probe-isolated-2.js が動いていない' });
    R.dynamicImport = await testDynamicImport();
    R.mainWorld = await askMainWorld();
    render();

    console.log('%c' + TAG + ' ▶ これから30秒間、状態の変化を記録します。'
      + 'YTM のシャッフル / リピート / 音量スライダーを何回か操作してください。',
      'font-weight:bold;color:#c60');
    R.watch = await watch(30);
    console.log('%c' + TAG + ' ▶ 記録終了（' + R.watch.length + ' パターン）。下の1行もコピーしてください。',
      'font-weight:bold;color:#0a0');
    console.log('[YTMPLUS-PROBE-JSON-2] ' + JSON.stringify({ controlDom: R.controlDom,
      videoState: R.videoState, queueShape: R.mainWorld && R.mainWorld.queueShape, watch: R.watch }));
  }, 4000);
})();
