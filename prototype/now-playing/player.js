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
// ?caps=repeat,volume … その capability を false にした画面を確認する。
//   契約 §3.8 の「できないことはボタンを無効化する」を実際に目で見るための窓。
// ?fail=timeout   … すべての操作を失敗させる。失敗表示を確認するための窓。
// どちらも確認用であり、実機の Adapter には存在しない。
const disabledCapabilities = Object.fromEntries(
  (params.get('caps') || '').split(',').filter(Boolean).map(key => [key, false]),
);
const adapter = withProbe(createMockAdapter({
  fixtures: FIXTURES,
  autoAdvance: !capture,
  lyricsDelayMs: 650,
  translationDelayMs: 400,
  capabilities: disabledCapabilities,
  opFailure: params.get('fail') || null,
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
  opError: '',                 // 直近の操作が失敗したときに出す文言
  pendingLyricsFocus: false,   // 歌詞の再取得後にフォーカスを歌詞へ戻すか
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

/**
 * 前回の描画で使った値。作り直しが必要かを判断するためだけに持つ。
 *
 * **キーには「表示に使う内容」まで入れる。** ID だけを見ていると、
 * 同じ曲IDのままタイトルやジャケットが後から届いた場合に描き直せない。
 * 実機では曲を検知した直後にメタデータや歌詞ソースが遅れて届くので、
 * これは実際に起こりうる（2026-09-07 Codex レビュー 中5）。
 */
const rendered = {
  trackInstanceId: null,
  videoId: null,
  trackKey: null,
  paletteKey: null,
  lyricsKey: null,
  translationKey: null,
  queueKey: null,
  repeat: null,
  shuffle: null,
  status: null,
};

/** キーを組み立てるときの区切り。曲名やアーティスト名に現れない文字を使う。 */
const SEP = '\u0001';

/* ------------------------------------------------------------------ *
 * 操作の実行係
 *
 * ここを1本にまとめている理由は2つある（2026-09-07 Codex レビュー 中3・中6）。
 *
 * **1. 応答待ち中の連打で操作が失われないようにする。**
 * UI は目標値を「直近に Adapter から受け取った値」から計算する。応答が返る前に
 * もう一度押されると、まだ古い値から計算してしまう。実際にリピートを2回押すと
 * `setRepeat('ALL')` が2回出て `ONE` へ進まなかった。
 * そこで**押された意図を関数のまま覚えておき、確定してから計算し直して発行する。**
 * ボタンは押せるままなので、`disabled` にしたときのようにフォーカスが body へ落ちない。
 *
 * **2. 失敗を捨てない。**
 * 操作はすべて `Promise<OpResult>` を返す。以前はそれを全部捨てていたので、
 * `timeout` や `rejected` が返っても利用者には何も伝わらなかった。
 * ------------------------------------------------------------------ */

/** 応答待ちの操作キー。 */
const inFlight = new Set();
/** キー → 待たされている意図の列。 */
const waiting = new Map();
/** 連打で無限に積まないための上限。 */
const WAITING_LIMIT = 4;

const OP_FAILURE_TEXT = {
  unsupported: 'この環境では実行できません',
  'not-found': '対象が見つかりませんでした',
  timeout: '応答がありませんでした',
  rejected: '実行できませんでした',
};

/**
 * 操作を1件実行する。
 *
 * @param {string} key      同時に走らせない単位。同じキーの操作は直列化される
 * @param {object} options
 * @param {string} options.label     失敗を伝えるときの日本語（例: 'リピートの変更'）
 * @param {'latest'|'sequence'} [options.policy]
 *   latest   … 目標値を指定する操作。待たされたぶんは最後の1件だけ残す
 *   sequence … 回数に意味がある操作（曲送り）。押した回数ぶん順に実行する
 * @param {() => Promise<import('../../src/js/newui/adapter/types.js').OpResult>} produce
 *   **呼ばれた時点の `latest` から目標値を計算すること。** 事前に計算しない
 * @param {(reason: string) => void} [onFailure]  失敗したときに UI 側で戻す処理
 */
function runAction(key, { label, policy = 'latest' }, produce, onFailure) {
  const entry = { label, policy, produce, onFailure };
  if (inFlight.has(key)) {
    const list = waiting.get(key) || [];
    waiting.set(key, policy === 'latest' ? [entry] : [...list, entry].slice(-WAITING_LIMIT));
    return;
  }
  inFlight.add(key);
  Promise.resolve()
    .then(() => entry.produce())
    .then((result) => {
      if (result && result.ok === false) failAction(entry, result.reason);
      else clearOpError();
    })
    // 契約では失敗は戻り値だが、実装が投げてきたときも UI は黙って壊れない。
    .catch(() => failAction(entry, 'rejected'))
    .finally(() => {
      inFlight.delete(key);
      const list = waiting.get(key);
      if (!list || !list.length) return;
      const [next, ...rest] = list;
      if (rest.length) waiting.set(key, rest); else waiting.delete(key);
      runAction(key, next, next.produce, next.onFailure);
    });
}

function failAction(entry, reason) {
  if (entry.onFailure) entry.onFailure(reason);
  // #playback-message は role="status" なので、書き込めば読み上げにも乗る。
  uiState.opError = `${entry.label}に失敗しました。${OP_FAILURE_TEXT[reason] || ''}`;
  renderTransport();
}

function clearOpError() {
  if (!uiState.opError) return;
  uiState.opError = '';
  renderTransport();
}

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
      runAction('seek', { label: 'この行へ移動' }, () => adapter.seek(line.at));
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
  // **再描画でフォーカスを body へ落とさない。**
  // キュー項目を選ぶと currentItemId が変わり、ここが全ボタンを差し替える。
  // 差し替え前にどの項目にフォーカスがあったかを覚えておき、あとで戻す
  // （2026-09-07 Codex レビュー 中4。実ブラウザで body に落ちることを確認した）。
  const active = document.activeElement;
  const focusedItemId = active && active.classList && active.classList.contains('queue-item')
    ? active.dataset.itemId : null;
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
    button.onclick = () => runAction(
      'select', { label: 'この曲の再生' },
      () => adapter.selectQueueItem(item.itemId),
    );
    return button;
  }));
  if (!focusedItemId) return;
  const container = $('queue-items');
  // 選んだ項目が消えていたら現在曲の行へ、それも無ければ先頭へ寄せる。
  const restored = container.querySelector(`[data-item-id="${CSS.escape(focusedItemId)}"]`)
    || container.querySelector('[aria-current="true"]')
    || container.querySelector('button');
  if (restored) restored.focus();
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
  // 操作の失敗は読み込み中より優先して出す。role="status" なので読み上げにも乗る。
  $('playback-message').textContent = uiState.opError
    || (status === 'buffering' ? '読み込み中…' : '');

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
  // ID だけでなく**表示に使う内容**をキーに入れる。同じ曲のままタイトルや
  // ジャケットが後から届いても描き直せるようにするため。
  const trackKey = track
    ? [track.instanceId, track.videoId, track.title, track.artist, track.album, track.artworkUrl].join(SEP)
    : '';
  const paletteKey = track ? JSON.stringify(track.palette) : null;
  const lyricsKey = lyricsAreCurrent()
    ? [state.lyrics.videoId, state.lyrics.status,
      state.lyrics.lines.map(l => `${l.id}@${l.at}:${l.text}`).join(SEP)].join('|')
    : `pending:${track ? track.videoId : ''}`;
  const translationKey = [uiState.translationVisible, state.lyrics.translation.status,
    Object.entries(state.lyrics.translation.byLineId).map(([id, text]) => `${id}:${text}`).join(SEP),
  ].join('|');
  const queueKey = [state.queue.status, state.queue.currentItemId,
    state.queue.items.map(i => [i.itemId, i.title, i.artist, i.artworkUrl].join(':')).join(SEP),
  ].join('|');

  // 音量が正のときだけ記憶する。「音量0から戻す」のは UI 独自の親切機能。
  if (state.player.volume > 0) uiState.lastNonzeroVolume = state.player.volume;

  // 「再生が新しく始まったか」は instanceId で見る。キュー項目IDで見ると、
  // 実機で並べ替えが起きたときに曲が変わっていないのに変わったと誤認する。
  const trackChanged = rendered.trackInstanceId !== (track ? track.instanceId : null);
  const songChanged = rendered.videoId !== (track ? track.videoId : null);
  if (rendered.trackKey !== trackKey || rendered.paletteKey !== paletteKey) {
    renderTrack();
    rendered.trackKey = trackKey;
    rendered.paletteKey = paletteKey;
  }
  rendered.trackInstanceId = track ? track.instanceId : null;
  rendered.videoId = track ? track.videoId : null;
  if (trackChanged) uiState.follow = true;
  // 読み上げは曲が変わったときだけ。リピート1の折り返しで同じ曲名を繰り返さない。
  if (songChanged && previous.player.track && track) announce(`${track.title}を再生`);
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
  restoreLyricsFocus();
  const { position, duration } = adapter.getPosition();
  updateProgress(position, duration);
}

/**
 * 歌詞の再取得後にフォーカスを戻す。
 *
 * 「もう一度読み込む」を押すとそのボタンが hidden になるため、何もしないと
 * フォーカスが body へ落ちる。押した直後は状態表示へ、復帰したら歌詞へ移す
 * （旧実装にはあった挙動で、Phase 6a で失われていた）。
 * 利用者が自分でどこかへフォーカスを移していたら、それを奪わない。
 */
function restoreLyricsFocus() {
  if (!uiState.pendingLyricsFocus) return;
  const status = effectiveLyricsStatus();
  if (status === 'loading') return;
  const active = document.activeElement;
  const ours = !active || active === document.body || $('lyric-message').contains(active);
  uiState.pendingLyricsFocus = false;
  if (!ours) return;
  if (status === 'ready' && !viewport.hidden) viewport.focus({ preventScroll: true });
  else $('lyric-message').focus();
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
  // 目標値の計算は runAction が実行する瞬間に行う。応答待ち中に押されたぶんも、
  // 確定後の最新の状態から計算し直される。
  runAction('playpause', { label: '再生の切り替え' }, () => {
    const status = latest.player.playback.status;
    return (status === 'paused' || status === 'ended' || status === 'idle')
      ? adapter.play() : adapter.pause();
  });
}

$('play').onclick = togglePlay;
// 曲送りは「押した回数」に意味があるので、待たされたぶんも順に実行する。
$('next').onclick = () => runAction('skip', { label: '次の曲へ', policy: 'sequence' }, () => adapter.next());
$('previous').onclick = () => runAction('skip', { label: '前の曲へ', policy: 'sequence' }, () => adapter.previous());
// 目標値を渡す。相対操作（cycleRepeat / toggleShuffle）は契約に無い。
// 目標値は「直近に Adapter から受け取った値」から計算する。
$('shuffle').onclick = () => runAction('shuffle', { label: 'シャッフルの切り替え' },
  () => adapter.setShuffle(!latest.player.shuffle));
$('repeat').onclick = () => runAction('repeat', { label: 'リピートの変更' },
  () => adapter.setRepeat(nextRepeat(latest.player.repeat)));
$('retry').onclick = () => {
  // このボタンは取得中のあいだ hidden になる。フォーカスを失う前に状態表示へ移す。
  uiState.pendingLyricsFocus = true;
  $('lyric-message').tabIndex = -1;
  $('lyric-message').focus();
  runAction('lyrics', { label: '歌詞の再取得' }, () => adapter.reloadLyrics());
};

$('mute').onclick = () => runAction('volume', { label: '消音の切り替え' }, () => {
  // 音量0からの復帰は UI 独自の機能。YTM の消音とは別物なので分けて扱う。
  if (latest.player.volume === 0) {
    return adapter.setVolume(uiState.lastNonzeroVolume)
      .then(result => (result.ok ? adapter.setMuted(false) : result));
  }
  return adapter.setMuted(!latest.player.muted);
});

$('volume').addEventListener('pointerdown', () => { uiState.volumeDragging = true; });
addEventListener('pointerup', () => { uiState.volumeDragging = false; });
$('volume').oninput = event => {
  $('volume-value').value = event.target.value;
  const target = Number(event.target.value);
  runAction('volume', { label: '音量の変更' }, () => adapter.setVolume(target));
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
  const target = Number(event.target.value);
  runAction('seek', { label: '再生位置の移動' }, () => adapter.seek(target));
  uiState.seeking = false;
  uiState.seekPreview = null;
};
addEventListener('pointerup', () => { uiState.seeking = false; uiState.seekPreview = null; });
addEventListener('pointercancel', () => { uiState.seeking = false; uiState.seekPreview = null; });

$('translation').onchange = event => {
  const wanted = event.target.checked;
  uiState.translationVisible = wanted;
  // 「見せたい」は UI ローカル、「取りに行く」は Adapter。
  // 取りに行けなかったら、見せたいという UI 側の状態も戻す。
  // そうしないとチェックだけ入って何も出ない状態が残る。
  runAction('translation', { label: '翻訳の取得' },
    () => adapter.setTranslationWanted(wanted),
    () => { uiState.translationVisible = false; renderLocal(); });
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
    const delta = event.key === 'ArrowLeft' ? -5 : 5;
    // 目標値は実行する瞬間の再生位置から求める。連打しても取りこぼさない。
    runAction('seek', { label: '再生位置の移動' },
      () => adapter.seek(adapter.getPosition().position + delta));
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
