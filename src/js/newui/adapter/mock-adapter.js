/**
 * モックデータで動く Player Adapter（Phase 6a）。
 *
 * types.js の契約をそのまま満たす。実機（ytm-adapter.js）と入れ替えても
 * UI 側は1行も変わらない、という状態を作るのがこの実装の目的である。
 *
 * ここは純粋な JavaScript で、DOM にも chrome API にも触らない。
 * 時計・タイマー・乱数はすべて注入できるので、Node のテストからそのまま動かせる。
 */

import {
  ok, fail, clampVolume, isRepeatMode, createCapabilities, createPendingOps,
} from './types.js';

/**
 * @typedef {object} MockTrackFixture
 * @property {string} itemId
 * @property {string} videoId
 * @property {string} title
 * @property {string} artist
 * @property {string} album
 * @property {string|null} artworkUrl
 * @property {import('./types.js').Palette|null} palette
 * @property {number|null} duration        null で「曲長不明」を再現できる
 * @property {boolean} [seekable]          既定 true。false でシーク不可を再現
 * @property {import('./types.js').LyricLine[]} [lines]  空配列なら status='empty'
 * @property {string} [lyricsSource]
 * @property {boolean} [lyricsFails]       true なら取得が失敗する
 * @property {Record<string,string>} [translation]  行ID → 訳文
 * @property {boolean} [translationFails]
 */

const clone = (value) => JSON.parse(JSON.stringify(value));

/**
 * @param {object} options
 * @param {MockTrackFixture[]} options.fixtures  キューの中身。順序がそのままキュー順
 * @param {() => number} [options.now]           ミリ秒を返す時計
 * @param {boolean} [options.autoAdvance]        false で再生位置が進まなくなる（?capture=1 用）
 * @param {number} [options.opDelayMs]           操作が確定するまでの遅延。pending を観測させるため
 * @param {number} [options.lyricsDelayMs]       歌詞取得の遅延
 * @param {number} [options.translationDelayMs]  翻訳取得の遅延
 * @param {() => number} [options.random]        シャッフルの乱数
 * @param {Partial<import('./types.js').Capabilities>} [options.capabilities]
 * @returns {import('./types.js').PlayerAdapter & {applyScenario: (name: string) => void}}
 */
export function createMockAdapter(options = {}) {
  const {
    fixtures = [],
    now = () => Date.now(),
    autoAdvance = true,
    opDelayMs = 0,
    lyricsDelayMs = 650,
    translationDelayMs = 400,
    random = Math.random,
    capabilities: capabilityOverrides = {},
    volume = 42,
    repeat = 'NONE',
    shuffle = false,
  } = options;

  const capabilities = createCapabilities(capabilityOverrides);
  /** @type {Set<(s: import('./types.js').AdapterState) => void>} */
  const listeners = new Set();
  /** @type {Set<ReturnType<typeof setTimeout>>} */
  const timers = new Set();
  let destroyed = false;

  const internal = {
    items: fixtures.map(f => ({ ...f })),
    currentItemId: fixtures.length ? fixtures[0].itemId : null,
    /** @type {import('./types.js').PlaybackStatus} */
    status: fixtures.length ? 'paused' : 'idle',
    basePosition: 0,
    baseAt: now(),
    volume: clampVolume(volume),
    muted: false,
    repeat: isRepeatMode(repeat) ? repeat : 'NONE',
    shuffle: !!shuffle,
    pending: { transport: false, seek: false, volume: false, repeat: false, shuffle: false },
    queueStatus: fixtures.length ? 'ready' : 'idle',
    queueError: null,
    translationWanted: false,
    lyrics: {
      videoId: null, status: 'idle', lines: [], source: null, error: null,
      translation: { status: 'idle', byLineId: {}, error: null },
    },
  };

  let revision = 0;
  /** @type {import('./types.js').AdapterState} */
  let state;

  /* ---------------- 時計 ---------------- */

  const currentItem = () => internal.items.find(i => i.itemId === internal.currentItemId) || null;
  const currentDuration = () => {
    const item = currentItem();
    return item && Number.isFinite(item.duration) ? item.duration : null;
  };

  /** 再生位置の正本。status が playing のときだけ実時間で進む。 */
  function positionNow() {
    if (internal.status !== 'playing' || !autoAdvance) return internal.basePosition;
    const elapsed = Math.max(0, (now() - internal.baseAt) / 1000);
    const raw = internal.basePosition + elapsed;
    const duration = currentDuration();
    return duration === null ? raw : Math.min(duration, raw);
  }

  /** 位置の基準を今の位置で打ち直す。status を変える前後で必ず呼ぶ。 */
  function reanchor(position = positionNow()) {
    internal.basePosition = Math.max(0, position);
    internal.baseAt = now();
  }

  /* ---------------- スナップショットの組み立て ---------------- */

  function buildState() {
    revision += 1;
    const item = currentItem();
    const duration = currentDuration();
    /** @type {import('./types.js').PlayerSnapshot} */
    const player = Object.freeze({
      revision,
      track: item ? Object.freeze({
        itemId: item.itemId,
        videoId: item.videoId,
        title: item.title,
        artist: item.artist,
        album: item.album,
        artworkUrl: item.artworkUrl ?? null,
        palette: item.palette ? clone(item.palette) : null,
      }) : null,
      playback: Object.freeze({
        status: internal.status,
        position: positionNow(),
        duration,
        positionUpdatedAt: now(),
        seekable: !!item && item.seekable !== false && duration !== null,
      }),
      volume: internal.volume,
      muted: internal.muted,
      repeat: internal.repeat,
      shuffle: internal.shuffle,
      capabilities,
      pending: createPendingOps(internal.pending),
    });
    /** @type {import('./types.js').QueueSnapshot} */
    const queue = Object.freeze({
      status: internal.queueStatus,
      items: Object.freeze(internal.items.map(i => Object.freeze({
        itemId: i.itemId,
        videoId: i.videoId,
        title: i.title,
        artist: i.artist,
        artworkUrl: i.artworkUrl ?? null,
      }))),
      currentItemId: internal.currentItemId,
      error: internal.queueError,
    });
    const lyrics = Object.freeze({
      videoId: internal.lyrics.videoId,
      status: internal.lyrics.status,
      lines: Object.freeze(internal.lyrics.lines.map(l => Object.freeze({ ...l }))),
      source: internal.lyrics.source,
      error: internal.lyrics.error,
      translation: Object.freeze({
        status: internal.lyrics.translation.status,
        byLineId: Object.freeze({ ...internal.lyrics.translation.byLineId }),
        error: internal.lyrics.translation.error,
      }),
    });
    return Object.freeze({ player, queue, lyrics });
  }

  function emit() {
    if (destroyed) return;
    state = buildState();
    for (const listener of Array.from(listeners)) listener(state);
  }

  /* ---------------- タイマー ---------------- */

  function later(fn, ms) {
    const id = setTimeout(() => { timers.delete(id); if (!destroyed) fn(); }, ms);
    timers.add(id);
    return id;
  }

  /* ---------------- 歌詞 ---------------- */

  let lyricsToken = 0;

  /**
   * 現在曲の歌詞を取りに行く。**遅延取得である。**
   * 曲が持っているのではなく、曲が変わってから取りに行く。
   */
  function loadLyricsForCurrent({ immediate = false } = {}) {
    const item = currentItem();
    lyricsToken += 1;
    const token = lyricsToken;
    if (!item || !capabilities.lyrics) {
      internal.lyrics = {
        videoId: item ? item.videoId : null, status: 'idle', lines: [],
        source: null, error: null,
        translation: { status: 'idle', byLineId: {}, error: null },
      };
      return;
    }
    internal.lyrics = {
      videoId: item.videoId, status: 'loading', lines: [], source: null, error: null,
      translation: { status: 'idle', byLineId: {}, error: null },
    };
    const settle = () => {
      // 遅れて届いた前の曲の歌詞を、現在曲の歌詞として書き込まないための門番。
      if (token !== lyricsToken) return;
      if (item.lyricsFails) {
        internal.lyrics.status = 'error';
        internal.lyrics.error = '歌詞を読み込めませんでした';
      } else {
        const lines = Array.isArray(item.lines) ? item.lines : [];
        internal.lyrics.status = lines.length ? 'ready' : 'empty';
        internal.lyrics.lines = lines.map(l => ({ ...l }));
        internal.lyrics.source = lines.length ? (item.lyricsSource || 'MOCK') : null;
      }
      maybeLoadTranslation();
      emit();
    };
    if (immediate || lyricsDelayMs <= 0) settle();
    else later(settle, lyricsDelayMs);
  }

  let translationToken = 0;

  function maybeLoadTranslation() {
    const item = currentItem();
    translationToken += 1;
    const token = translationToken;
    if (!internal.translationWanted || !capabilities.translation
        || internal.lyrics.status !== 'ready' || !item) {
      internal.lyrics.translation = { status: 'idle', byLineId: {}, error: null };
      return;
    }
    internal.lyrics.translation = { status: 'loading', byLineId: {}, error: null };
    const settle = () => {
      if (token !== translationToken) return;
      if (item.translationFails) {
        internal.lyrics.translation = { status: 'error', byLineId: {}, error: '翻訳を取得できませんでした' };
      } else {
        internal.lyrics.translation = {
          status: 'ready', byLineId: { ...(item.translation || {}) }, error: null,
        };
      }
      emit();
    };
    if (translationDelayMs <= 0) settle();
    else later(settle, translationDelayMs);
  }

  /* ---------------- 曲末尾の処理 ---------------- */

  let endWatcher = null;

  function ensureEndWatcher() {
    if (!autoAdvance) return;
    if (internal.status === 'playing' && endWatcher === null) {
      endWatcher = setInterval(checkEnd, 100);
    } else if (internal.status !== 'playing' && endWatcher !== null) {
      clearInterval(endWatcher);
      endWatcher = null;
    }
  }

  function checkEnd() {
    const duration = currentDuration();
    if (duration === null || internal.status !== 'playing') return;
    if (positionNow() < duration) return;
    if (internal.repeat === 'ONE') {
      reanchor(0);
      emit();
      return;
    }
    const index = internal.items.findIndex(i => i.itemId === internal.currentItemId);
    const isLast = index === internal.items.length - 1;
    if (internal.repeat === 'NONE' && isLast) {
      reanchor(duration);
      internal.status = 'ended';
      ensureEndWatcher();
      emit();
      return;
    }
    moveTo(pickNextItemId(1), { play: true });
    emit();
  }

  /** シャッフル中は現在曲以外から選ぶ。前送りはシャッフルしない（SPEC.md §2）。 */
  function pickNextItemId(direction) {
    const count = internal.items.length;
    if (!count) return null;
    const index = internal.items.findIndex(i => i.itemId === internal.currentItemId);
    if (internal.shuffle && direction > 0 && count > 1) {
      const offset = 1 + Math.floor(random() * (count - 1));
      return internal.items[(index + offset) % count].itemId;
    }
    return internal.items[(index + direction + count) % count].itemId;
  }

  function moveTo(itemId, { play = true } = {}) {
    if (!itemId) return false;
    if (!internal.items.some(i => i.itemId === itemId)) return false;
    internal.currentItemId = itemId;
    reanchor(0);
    internal.status = play ? 'playing' : 'paused';
    ensureEndWatcher();
    loadLyricsForCurrent();
    return true;
  }

  /* ---------------- 操作の共通処理 ---------------- */

  /**
   * 操作を「pending を立てる → 確定する」の2段で流す。
   * **UI が成功を仮定しないことを、モックの側でも強制する**ための仕組み。
   * apply の戻り値: undefined なら成功、false なら 'not-found'、
   * 文字列ならそれを失敗理由として返す。
   */
  function runOp(key, apply, { requires } = {}) {
    if (destroyed) return Promise.resolve(fail('rejected'));
    if (requires && !capabilities[requires]) return Promise.resolve(fail('unsupported'));
    internal.pending[key] = true;
    emit();
    return new Promise((resolve) => {
      const settle = () => {
        const result = apply();
        internal.pending[key] = false;
        ensureEndWatcher();
        emit();
        if (result === false) resolve(fail('not-found'));
        else if (typeof result === 'string') resolve(fail(result));
        else resolve(ok());
      };
      if (opDelayMs <= 0) Promise.resolve().then(settle);
      else later(settle, opDelayMs);
    });
  }

  /* ---------------- 公開インターフェース ---------------- */

  const adapter = {
    subscribe(listener) {
      listeners.add(listener);
      listener(state);
      return () => { listeners.delete(listener); };
    },

    getState: () => state,

    // RAF から毎フレーム呼ばれる。**スナップショットを作らないし通知も出さない。**
    getPosition: () => ({ position: positionNow(), duration: currentDuration() }),

    play: () => runOp('transport', () => {
      if (!currentItem()) return false;
      // 末尾で止まっているときの再生は頭出しを兼ねる。
      const duration = currentDuration();
      if (internal.status === 'ended' || (duration !== null && positionNow() >= duration)) reanchor(0);
      else reanchor();
      internal.status = 'playing';
    }),

    pause: () => runOp('transport', () => {
      if (!currentItem()) return false;
      reanchor();
      internal.status = 'paused';
    }),

    seek: (seconds) => runOp('seek', () => {
      const item = currentItem();
      if (!item) return false;
      // 曲長不明・シーク不可は「見つからない」ではなく「できない」。
      if (item.seekable === false) return 'unsupported';
      const duration = currentDuration();
      if (duration === null) return 'unsupported';
      const target = Math.max(0, Math.min(duration, Number(seconds) || 0));
      reanchor(target);
      if (internal.status === 'ended' && target < duration) internal.status = 'paused';
    }, { requires: 'seek' }),

    next: () => runOp('transport', () => moveTo(pickNextItemId(1))),
    previous: () => runOp('transport', () => moveTo(pickNextItemId(-1))),

    selectQueueItem: (itemId) => runOp('transport', () => moveTo(itemId), { requires: 'queue' }),

    setVolume: (value) => runOp('volume', () => {
      internal.volume = clampVolume(value);
      // 音量を上げたら消音は解除される。YTM の実挙動に合わせた仮定。
      if (internal.volume > 0) internal.muted = false;
    }, { requires: 'volume' }),

    setMuted: (muted) => runOp('volume', () => {
      internal.muted = !!muted;
    }, { requires: 'volume' }),

    // 目標値指定。相対操作（cycleRepeat）は置かない。
    setRepeat: (mode) => runOp('repeat', () => {
      if (!isRepeatMode(mode)) return false;
      internal.repeat = mode;
    }, { requires: 'repeat' }),

    setShuffle: (enabled) => runOp('shuffle', () => {
      internal.shuffle = !!enabled;
    }, { requires: 'shuffle' }),

    setTranslationWanted: (enabled) => {
      if (destroyed) return Promise.resolve(fail('rejected'));
      if (!capabilities.translation) return Promise.resolve(fail('unsupported'));
      internal.translationWanted = !!enabled;
      maybeLoadTranslation();
      emit();
      return Promise.resolve(ok());
    },

    reloadLyrics: () => {
      if (destroyed) return Promise.resolve(fail('rejected'));
      if (!capabilities.lyrics) return Promise.resolve(fail('unsupported'));
      loadLyricsForCurrent();
      emit();
      return Promise.resolve(ok());
    },

    destroy() {
      destroyed = true;
      listeners.clear();
      for (const id of timers) clearTimeout(id);
      timers.clear();
      if (endWatcher !== null) { clearInterval(endWatcher); endWatcher = null; }
    },

    /* ------ 以下はモック専用。契約には含まれない ------ */

    /**
     * プロトタイプの「表示する状態」セレクタ用。
     * 実機の Adapter には存在しないので、UI 側は契約経由でしか触らないこと。
     */
    applyScenario(name) {
      const byIndex = { long: 1, neutral: 2 };
      const target = internal.items[byIndex[name] ?? 0];
      if (!target) return;
      internal.currentItemId = target.itemId;
      reanchor(byIndex[name] === undefined ? 140 : 10);
      internal.status = name === 'paused' ? 'paused' : name === 'loading' ? 'buffering' : 'playing';
      internal.translationWanted = name === 'translation';
      lyricsToken += 1;
      translationToken += 1;
      const lines = Array.isArray(target.lines) ? target.lines : [];
      const status = name === 'lyrics-loading' ? 'loading'
        : name === 'lyrics-error' ? 'error'
        : name === 'no-lyrics' ? 'empty'
        : lines.length ? 'ready' : 'empty';
      internal.lyrics = {
        videoId: target.videoId,
        status,
        lines: status === 'ready' ? lines.map(l => ({ ...l })) : [],
        source: status === 'ready' ? (target.lyricsSource || 'MOCK') : null,
        error: status === 'error' ? '歌詞を読み込めませんでした' : null,
        translation: internal.translationWanted && status === 'ready'
          ? { status: 'ready', byLineId: { ...(target.translation || {}) }, error: null }
          : { status: 'idle', byLineId: {}, error: null },
      };
      ensureEndWatcher();
      emit();
    },

    /** プロトタイプの「モックの初期画面へ戻す」用。 */
    resetPlayerSettings() {
      internal.volume = clampVolume(volume);
      internal.muted = false;
      internal.repeat = 'NONE';
      internal.shuffle = false;
      emit();
    },
  };

  state = buildState();
  loadLyricsForCurrent({ immediate: true });
  state = buildState();
  return adapter;
}
