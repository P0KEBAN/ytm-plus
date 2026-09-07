/**
 * Now Playing プロトタイプの表示層（Phase 6a で Adapter の上へ載せ替えた）。
 *
 * ## この書き換えで何が変わったか
 *
 * 以前はこのファイルが `state` オブジェクトひとつに、性質の違う3種類を混ぜて持っていた。
 *
 *   1. 再生エンジンが正解を持つ値（再生状態・音量・リピート・シャッフル・キュー・歌詞）
 *   2. UI が勝手に決めてよい値（追従・表示切替・コントラスト・動き）
 *   3. 毎フレーム導出するだけで保存しなくてよい値（現在行・再生位置）
 *
 * そして 1 を「UI が書き換えたら、それがそのまま真実になる」構造で扱っていた。
 * 実機ではここが逆転する。YouTube Music が真実を持ち、UI は結果を受け取る側になる。
 *
 * いまは 1 を Adapter が持ち、UI は `adapter.subscribe()` で受け取るだけになった。
 * **UI は操作の成功を仮定しない。** ボタンを押しても自分の状態は書き換えず、
 * Adapter から返ってきた正規の状態で確定させる。
 *
 * 2 は下の `uiState` に残る。3 は RAF の中で毎フレーム導出する。
 *
 * 契約は src/js/newui/adapter/types.js。設計の根拠は docs/ADAPTER-CONTRACT.md。
 */

import { createMockAdapter } from '../../src/js/newui/adapter/mock-adapter.js';
import { REPEAT_MODES, formatTime, lyricsMatchTrack } from '../../src/js/newui/adapter/types.js';
import { FIXTURES } from './mock-data.js';

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const capture = params.get('capture') === '1';
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

/* ------------------------------------------------------------------ *
 * 再生エンジン（プロトタイプではモック）
 * ------------------------------------------------------------------ */

/**
 * ?probe=1 のときだけ、Adapter への操作呼び出しを `window.__adapterCalls` に記録する。
 * **自動検証（check.cjs）専用の窓であり、UI の制御経路ではない。**
 *
 * 以前は `document` に `player-action` という CustomEvent を投げており、
 * それが「操作意図の出口」を兼ねていた。Adapter が出口になったのでイベントは廃止したが、
 * 「キー操作1回で seek が1回だけ発行されること」のような検査は残す価値がある。
 * 読み取り（getState / getPosition）は毎フレーム呼ばれるので記録しない。
 */
function withProbe(target) {
  if (params.get('probe') !== '1') return target;
  const calls = [];
  window.__adapterCalls = calls;
  const readOnly = new Set(['subscribe', 'getState', 'getPosition', 'destroy']);
  return new Proxy(target, {
    get(object, property) {
      const value = object[property];
      if (typeof value !== 'function' || readOnly.has(property)) return value;
      return (...args) => { calls.push({ method: property, args }); return value.apply(object, args); };
    },
  });
}

// ?capture=1 は再生位置を止める。比較用スクリーンショットを撮るたびに
// 絵が変わらないようにするため。
//
// **歌詞・翻訳の取得遅延は capture では止めない。** 初期表示は applyScenario が
// 終端状態を直接置くので取得中を経由せず、スクリーンショットは決定的なままである。
// 一方この遅延を 0 にすると、「再試行すると取得中を経由する」ことを検証できなくなる。
const adapter = withProbe(createMockAdapter({
  fixtures: FIXTURES,
  autoAdvance: !capture,
  lyricsDelayMs: 650,
  translationDelayMs: 400,
}));

/** 直近のスナップショット。**UI はこれを書き換えない（凍結されている）。** */
let latest = adapter.getState();

/* ------------------------------------------------------------------ *
 * UIローカル状態（Adapter の外）
 *
 * 判定の基準は「YouTube Music を再起動しても復元されるべき値か」。
 * 音量やリピートは YTM 側の値なので Adapter。追従や表示切替は
 * YTM が知らないのでここ。
 * ------------------------------------------------------------------ */

const uiState = {
  view: 'lyrics',              // 右側に歌詞を出すかキューを出すか
  follow: true,                // 歌詞の自動追従
  activeLineIndex: -1,         // 位置から毎フレーム導出。保存しない
  translationVisible: false,   // 見せるか。取りに行くかは Adapter へ伝える
  highContrast: false,
  motion: true,
  lastNonzeroVolume: 42,       // 「音量0から戻す」ための UI 独自の記憶
  seeking: false,              // シークバーをドラッグ中
  seekPreview: null,           // ドラッグ中に見せている値
  volumeDragging: false,
};

/* ------------------------------------------------------------------ *
 * 描画のための小道具
 * ------------------------------------------------------------------ */

const lineElements = [];
const translationElements = new Map();   // 行ID → 訳文の span
let offsets = [];
let rafId = null;
let layoutPending = true;
let progressAt = -Infinity;
const viewport = $('lyric-viewport');

const announce = text => { $('announcement').textContent = text; };

/** 前回の描画で使った値。作り直しが必要かを判断するためだけに持つ。 */
const rendered = {
  trackItemId: null,
  paletteKey: null,
  lyricsKey: null,
  translationKey: null,
  queueKey: null,
  repeat: null,
  shuffle: null,
  status: null,
};

/* ------------------------------------------------------------------ *
 * 配色
 * ------------------------------------------------------------------ */

const FALLBACK_PALETTE = {
  ui: { primary: '#4a4f56', secondary: '#8b9096', shadow: '#1b1f25' },
  background: { base: '#0d1117', spot0: '#3b4450', spot1: '#252c35', spot2: '#0d1117', spot3: '#7d858e' },
};

/**
 * パレットを CSS カスタムプロパティへ流す。
 *
 * 背景は5色すべてを必須で読む。欠けていたら既定色へ落として警告を出すだけにする
 * （例外で初期化ごと止めない）。SPEC.md §1 の但し書きのとおり。
 */
function applyPalette(palette) {
  const source = palette && palette.ui && palette.background ? palette : null;
  if (!source) console.warn('[prototype] パレットが不完全です。既定色へ落とします', palette);
  const resolved = source || FALLBACK_PALETTE;
  const flat = { ...resolved.ui, ...resolved.background };
  for (const [key, value] of Object.entries(flat)) {
    document.documentElement.style.setProperty(`--art-${key}`, value);
  }
  window.Smoke.readPalette();
}

/* ------------------------------------------------------------------ *
 * 歌詞
 * ------------------------------------------------------------------ */

/**
 * 歌詞が「いま鳴っている曲のもの」かどうか。
 *
 * 歌詞は遅れて届くので、曲を変えた直後に前の曲の歌詞が到着することがある。
 * ここで弾かないと、別の曲の歌詞が一瞬表示される。
 */
const lyricsAreCurrent = () => lyricsMatchTrack(latest.lyrics, latest.player.track);

/** 表示上の歌詞状態。曲と食い違っている間は「取得中」として扱う。 */
function effectiveLyricsStatus() {
  if (!latest.player.track) return 'idle';
  if (!lyricsAreCurrent()) return 'loading';
  return latest.lyrics.status;
}

/** 行の DOM を作り直す。**歌詞の行そのものが変わったときだけ呼ぶ。** */
function rebuildLines() {
  const fragment = document.createDocumentFragment();
  lineElements.length = 0;
  translationElements.clear();
  const lines = lyricsAreCurrent() ? latest.lyrics.lines : [];
  for (const line of lines) {
    const button = document.createElement('button');
    button.className = 'lyric-line';
    button.dataset.lineId = line.id;
    const original = document.createElement('span');
    original.className = 'original';
    original.textContent = line.text;
    button.append(original);
    // 訳文の器は最初から置いておく。翻訳が後から届いても行を作り直さずに済む。
    const translated = document.createElement('span');
    translated.className = 'translation';
    translated.hidden = true;
    button.append(translated);
    translationElements.set(line.id, translated);
    // 行IDを秒へ解決するのは UI の仕事。Adapter に seekToLyricLine は無い。
    button.addEventListener('click', () => {
      uiState.follow = true;
      adapter.seek(line.at);
    });
    button.addEventListener('focus', manualFollow);
    fragment.append(button);
    lineElements.push(button);
  }
  $('lyric-lines').replaceChildren(fragment);
  uiState.activeLineIndex = -1;
  layoutPending = true;
}

/**
 * 訳文だけを差し込む。**行の DOM は作り直さない。**
 *
 * 訳文を LyricLine の中に入れず対応表で持っているのは、これをやるためである。
 * 行の中に入れていると、翻訳が届くたびに歌詞 DOM が丸ごと再構築される。
 */
function applyTranslations() {
  const translation = latest.lyrics.translation;
  const show = uiState.translationVisible && lyricsAreCurrent() && translation.status === 'ready';
  for (const [lineId, element] of translationElements) {
    const text = show ? translation.byLineId[lineId] : '';
    element.textContent = text || '';
    element.hidden = !text;
  }
  for (const button of lineElements) {
    const lineId = button.dataset.lineId;
    const line = latest.lyrics.lines.find(l => l.id === lineId);
    if (!line) continue;
    const translated = show ? translation.byLineId[lineId] : '';
    button.setAttribute('aria-label', [line.text, translated, `${formatTime(line.at)}へ移動`]
      .filter(Boolean).join('、'));
  }
  layoutPending = true;
}

function manualFollow() {
  if (!uiState.follow || effectiveLyricsStatus() !== 'ready') return;
  uiState.follow = false;
  $('resume-follow').hidden = false;
}

function followLine(instant = false) {
  if (!uiState.follow || uiState.activeLineIndex < 0 || viewport.hidden) return;
  const top = Math.max(0, offsets[uiState.activeLineIndex] - 128);
  if (!Number.isFinite(top)) return;
  viewport.scrollTo({ top, behavior: instant || reducedMotion.matches || capture ? 'instant' : 'smooth' });
}

/* ------------------------------------------------------------------ *
 * 描画
 * ------------------------------------------------------------------ */

function renderTrack() {
  const track = latest.player.track;
  $('title').textContent = track ? track.title : '';
  $('title').title = track ? track.title : '';
  $('artist').textContent = track ? track.artist : '';
  $('artist').title = track ? track.artist : '';
  const artworkUrl = track && track.artworkUrl;
  $('artwork').hidden = !artworkUrl;
  $('abstract-art').hidden = !!artworkUrl;
  if (artworkUrl) {
    $('artwork').onerror = () => { $('artwork').hidden = true; $('abstract-art').hidden = false; };
    $('artwork').src = artworkUrl;
    $('artwork').alt = `${track.album}のアルバムジャケット`;
  }
  applyPalette(track ? track.palette : null);
}

function renderQueue() {
  const { items, currentItemId } = latest.queue;
  $('queue-items').replaceChildren(...items.map((item) => {
    const button = document.createElement('button');
    button.className = 'queue-item';
    button.dataset.itemId = item.itemId;
    button.setAttribute('aria-current', String(item.itemId === currentItemId));
    const title = document.createElement('strong');
    title.textContent = item.title;
    const artist = document.createElement('span');
    artist.textContent = `${item.itemId === currentItemId ? '再生中 · ' : ''}${item.artist}`;
    button.append(title, artist);
    // 配列インデックスではなく安定ID で選曲する。
    button.onclick = () => adapter.selectQueueItem(item.itemId);
    return button;
  }));
}

function renderTransport() {
  const { playback, repeat, shuffle, capabilities, pending, volume, muted } = latest.player;
  const status = playback.status;
  const stopped = status === 'paused' || status === 'ended' || status === 'idle';

  $('play').setAttribute('aria-label',
    status === 'buffering' ? '読み込みを中止して一時停止' : stopped ? '再生' : '一時停止');
  // 応答待ちであることを伝える。UI は結果を先取りしない。
  $('play').toggleAttribute('aria-busy', pending.transport);
  $('pause-icon').toggleAttribute('hidden', status !== 'playing');
  $('play-icon').toggleAttribute('hidden', !stopped);
  $('spinner').hidden = status !== 'buffering';
  $('playback-message').textContent = status === 'buffering' ? '読み込み中…' : '';

  $('shuffle').setAttribute('aria-pressed', String(shuffle));
  $('shuffle').disabled = !capabilities.shuffle;
  const repeatName = { NONE: 'オフ', ALL: '全曲', ONE: '1曲' }[repeat];
  $('repeat').setAttribute('aria-label', `リピート：${repeatName}`);
  $('repeat').setAttribute('aria-pressed', String(repeat !== 'NONE'));
  $('repeat').disabled = !capabilities.repeat;
  document.querySelector('.repeat-one').hidden = repeat !== 'ONE';

  if (!uiState.volumeDragging) {
    $('volume').value = volume;
    $('volume-value').value = volume;
  }
  $('volume').disabled = !capabilities.volume;
  $('mute').disabled = !capabilities.volume;
  const silent = muted || volume === 0;
  $('mute').setAttribute('aria-pressed', String(silent));
  $('mute').textContent = silent ? '消音を解除' : '消音';

  $('seek').disabled = !playback.seekable;
  $('seek').max = playback.duration ?? 0;
  $('duration').textContent = formatTime(playback.duration);
}

function renderPanels() {
  const status = effectiveLyricsStatus();
  const showingLyrics = uiState.view === 'lyrics';
  document.body.classList.toggle('with-translation', uiState.translationVisible);
  document.body.classList.toggle('high-contrast', uiState.highContrast);
  $('translation').checked = uiState.translationVisible;
  $('contrast').checked = uiState.highContrast;
  $('motion').checked = uiState.motion;
  window.Smoke.setMotion(uiState.motion);

  document.querySelector('.right-panel').setAttribute('aria-label', showingLyrics ? '歌詞' : 'キュー');
  viewport.hidden = !showingLyrics || status !== 'ready';
  $('lyric-message').hidden = !showingLyrics || status === 'ready';
  $('lyric-message-text').textContent = {
    loading: '歌詞を読み込んでいます…',
    empty: 'この曲の歌詞はありません',
    error: '歌詞を読み込めませんでした',
  }[status] || '';
  $('retry').hidden = status !== 'error';
  $('queue-panel').hidden = showingLyrics;
  $('lyrics-view').setAttribute('aria-pressed', String(showingLyrics));
  $('queue-view').setAttribute('aria-pressed', String(!showingLyrics));
  $('resume-follow').hidden = uiState.follow || !showingLyrics || status !== 'ready';
}

/** 再生位置まわり。RAF からも呼ばれるので軽く保つ。 */
function updateProgress(position, duration) {
  const shown = uiState.seeking && uiState.seekPreview !== null ? uiState.seekPreview : position;
  const wholeSecond = Math.round(shown);
  if (!uiState.seeking && Number($('seek').value) !== wholeSecond) $('seek').value = wholeSecond;
  $('seek-fill').style.transform = `scaleX(${duration ? Math.min(1, shown / duration) : 0})`;
  const elapsed = formatTime(shown);
  if ($('elapsed').textContent !== elapsed) $('elapsed').textContent = elapsed;
  const valueText = `${elapsed} / ${formatTime(duration)}`;
  if ($('seek').getAttribute('aria-valuetext') !== valueText) {
    $('seek').setAttribute('aria-valuetext', valueText);
  }
}

/* ------------------------------------------------------------------ *
 * スナップショットの受け取り
 * ------------------------------------------------------------------ */

function onState(state) {
  const previous = latest;
  latest = state;

  const { track } = state.player;
  const paletteKey = track ? JSON.stringify(track.palette) : null;
  const lyricsKey = lyricsAreCurrent()
    ? `${state.lyrics.videoId}|${state.lyrics.status}|${state.lyrics.lines.map(l => l.id).join(',')}`
    : `pending:${track ? track.videoId : ''}`;
  const translationKey = `${uiState.translationVisible}|${state.lyrics.translation.status}|${Object.keys(state.lyrics.translation.byLineId).join(',')}`;
  const queueKey = `${state.queue.status}|${state.queue.currentItemId}|${state.queue.items.map(i => i.itemId).join(',')}`;

  // 音量が正のときだけ記憶する。「音量0から戻す」のは UI 独自の親切機能。
  if (state.player.volume > 0) uiState.lastNonzeroVolume = state.player.volume;

  const trackChanged = rendered.trackItemId !== (track ? track.itemId : null);
  if (trackChanged || rendered.paletteKey !== paletteKey) {
    renderTrack();
    rendered.trackItemId = track ? track.itemId : null;
    rendered.paletteKey = paletteKey;
  }
  if (trackChanged) {
    uiState.follow = true;
    if (previous.player.track && track) announce(`${track.title}を再生`);
  }
  if (rendered.lyricsKey !== lyricsKey) {
    rebuildLines();
    rendered.lyricsKey = lyricsKey;
    rendered.translationKey = null;    // 行を作り直したので訳も貼り直す
  }
  if (rendered.translationKey !== translationKey) {
    applyTranslations();
    rendered.translationKey = translationKey;
  }
  if (rendered.queueKey !== queueKey) {
    renderQueue();
    rendered.queueKey = queueKey;
  }

  // 読み上げは「実際に起きたこと」を伝える。操作した時点ではなく状態が変わった時点。
  if (rendered.repeat !== null && rendered.repeat !== state.player.repeat) {
    announce(`リピート：${{ NONE: 'オフ', ALL: '全曲', ONE: '1曲' }[state.player.repeat]}`);
  }
  if (rendered.shuffle !== null && rendered.shuffle !== state.player.shuffle) {
    announce(`シャッフル${state.player.shuffle ? 'オン' : 'オフ'}`);
  }
  if (rendered.status === 'playing' && state.player.playback.status === 'paused') announce('一時停止');
  rendered.repeat = state.player.repeat;
  rendered.shuffle = state.player.shuffle;
  rendered.status = state.player.playback.status;

  renderTransport();
  renderPanels();
  const { position, duration } = adapter.getPosition();
  updateProgress(position, duration);
}

/** UIローカル状態だけを変えたときの再描画。Adapter は関係しない。 */
function renderLocal() {
  renderPanels();
  applyTranslations();
  rendered.translationKey = `${uiState.translationVisible}|${latest.lyrics.translation.status}|${Object.keys(latest.lyrics.translation.byLineId).join(',')}`;
}

/* ------------------------------------------------------------------ *
 * 操作の配線
 *
 * **どのハンドラも UI の状態を書き換えない。** Adapter を呼ぶだけで、
 * 表示は返ってきたスナップショットで確定する。
 * ------------------------------------------------------------------ */

const nextRepeat = mode => REPEAT_MODES[(REPEAT_MODES.indexOf(mode) + 1) % REPEAT_MODES.length];

function togglePlay() {
  const status = latest.player.playback.status;
  if (status === 'paused' || status === 'ended' || status === 'idle') adapter.play();
  else adapter.pause();
}

$('play').onclick = togglePlay;
$('next').onclick = () => adapter.next();
$('previous').onclick = () => adapter.previous();
// 目標値を渡す。相対操作（cycleRepeat / toggleShuffle）は契約に無い。
// 目標値は「直近に Adapter から受け取った値」から計算する。
$('shuffle').onclick = () => adapter.setShuffle(!latest.player.shuffle);
$('repeat').onclick = () => adapter.setRepeat(nextRepeat(latest.player.repeat));
$('retry').onclick = () => adapter.reloadLyrics();

$('mute').onclick = () => {
  // 音量0からの復帰は UI 独自の機能。YTM の消音とは別物なので分けて扱う。
  if (latest.player.volume === 0) {
    adapter.setVolume(uiState.lastNonzeroVolume);
    adapter.setMuted(false);
  } else {
    adapter.setMuted(!latest.player.muted);
  }
};

$('volume').addEventListener('pointerdown', () => { uiState.volumeDragging = true; });
addEventListener('pointerup', () => { uiState.volumeDragging = false; });
$('volume').oninput = event => {
  $('volume-value').value = event.target.value;
  adapter.setVolume(Number(event.target.value));
};

$('seek').addEventListener('pointerdown', () => {
  uiState.seeking = true;
  uiState.seekPreview = adapter.getPosition().position;
});
$('seek').oninput = event => {
  uiState.seekPreview = Number(event.target.value);
  updateProgress(uiState.seekPreview, latest.player.playback.duration);
};
$('seek').onchange = event => {
  adapter.seek(Number(event.target.value));
  uiState.seeking = false;
  uiState.seekPreview = null;
};
addEventListener('pointerup', () => { uiState.seeking = false; uiState.seekPreview = null; });
addEventListener('pointercancel', () => { uiState.seeking = false; uiState.seekPreview = null; });

$('translation').onchange = event => {
  uiState.translationVisible = event.target.checked;
  // 「見せたい」は UI ローカル、「取りに行く」は Adapter。
  adapter.setTranslationWanted(event.target.checked);
  renderLocal();
};
$('contrast').onchange = event => { uiState.highContrast = event.target.checked; renderLocal(); };
$('motion').onchange = event => { uiState.motion = event.target.checked; renderLocal(); };

$('resume-follow').onclick = () => {
  uiState.follow = true;
  followLine();
  viewport.focus({ preventScroll: true });
  renderPanels();
};
$('queue-view').onclick = () => {
  uiState.view = 'queue';
  renderPanels();
  $('queue-items').querySelector('button')?.focus();
};
$('lyrics-view').onclick = () => {
  uiState.view = 'lyrics';
  layoutPending = true;
  renderPanels();
  $('lyrics-view').focus();
};

$('more').onclick = () => $('options').showModal();
$('close-options').onclick = () => $('options').close();
$('options').addEventListener('close', () => $('more').focus());

/* ---- 以下2つはモック専用の確認用UI。実機の Adapter には存在しない ---- */
$('scenario').onchange = event => {
  window.Smoke.reset();
  uiState.follow = true;
  uiState.view = 'lyrics';
  uiState.translationVisible = event.target.value === 'translation';
  adapter.applyScenario(event.target.value);
  renderLocal();
};
$('reset').onclick = () => {
  Object.assign(uiState, {
    view: 'lyrics', follow: true, translationVisible: false,
    highContrast: false, motion: true, lastNonzeroVolume: 42,
  });
  adapter.resetPlayerSettings();
  window.Smoke.reset();
  adapter.applyScenario('playing');
  $('scenario').value = 'playing';
  renderLocal();
  $('options').close();
};

/* ------------------------------------------------------------------ *
 * キーボードとスクロール
 * ------------------------------------------------------------------ */

viewport.addEventListener('wheel', manualFollow, { passive: true });
viewport.addEventListener('touchstart', manualFollow, { passive: true });
viewport.addEventListener('keydown', event => {
  if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(event.key)) manualFollow();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !$('options').open && uiState.view === 'queue') {
    uiState.view = 'lyrics';
    renderPanels();
    $('queue-view').focus();
    return;
  }
  if ($('options').open || event.target.closest('input, select, button, summary, textarea')
      || event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.code === 'Space') { event.preventDefault(); togglePlay(); }
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault();
    adapter.seek(adapter.getPosition().position + (event.key === 'ArrowLeft' ? -5 : 5));
  }
});

/* ------------------------------------------------------------------ *
 * レイアウトと RAF
 * ------------------------------------------------------------------ */

function layout() {
  document.documentElement.style.setProperty('--scale', Math.min(innerWidth / 1920, innerHeight / 1080));
  layoutPending = true;
}
new ResizeObserver(() => { layoutPending = true; }).observe($('lyric-lines'));
addEventListener('resize', layout);

let firstFrame = true;

function frame(now) {
  // 再生位置は購読ではなくここで取る。**スナップショットを毎フレーム作らない。**
  const { position, duration } = adapter.getPosition();

  // 現在行はキャッシュした時刻配列の二分探索。DOM は行が変わったときだけ触る。
  if (effectiveLyricsStatus() === 'ready') {
    const lines = latest.lyrics.lines;
    let low = 0, high = lines.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (lines[mid].at <= position) low = mid + 1; else high = mid;
    }
    const active = low - 1;
    if (active !== uiState.activeLineIndex) {
      const before = lineElements[uiState.activeLineIndex];
      if (before) { before.classList.remove('is-active'); before.removeAttribute('aria-current'); }
      uiState.activeLineIndex = active;
      const after = lineElements[active];
      if (after) { after.classList.add('is-active'); after.setAttribute('aria-current', 'true'); }
      layoutPending = true;
    }
  }

  if (layoutPending && !viewport.hidden) {
    // 行座標は、行・フォント・翻訳・ビューポートが変わったときだけ読む。
    offsets = lineElements.map(el => el.offsetTop - $('lyric-lines').offsetTop);
    followLine(firstFrame || capture);
    layoutPending = false;
  }

  if (now - progressAt > 100) { updateProgress(position, duration); progressAt = now; }
  window.Smoke.tick(now);
  firstFrame = false;
  rafId = requestAnimationFrame(frame);
}

document.addEventListener('visibilitychange', () => {
  cancelAnimationFrame(rafId);
  // 再生位置は Adapter が持っているので、描画を止めても時刻はずれない。
  // 以前はこのファイルが時計を持っていたため、復帰時に位置が飛んでいた。
  if (!document.hidden) rafId = requestAnimationFrame(frame);
});

/* ------------------------------------------------------------------ *
 * 起動
 * ------------------------------------------------------------------ */

layout();
window.Smoke.init();
adapter.subscribe(onState);
const initialScenario = params.get('state') || 'playing';
uiState.translationVisible = initialScenario === 'translation';
adapter.applyScenario(initialScenario);
$('scenario').value = initialScenario;
renderLocal();
rafId = requestAnimationFrame(frame);
