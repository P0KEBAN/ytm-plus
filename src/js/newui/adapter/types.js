/**
 * Player Adapter の契約（Phase 6a）。
 *
 * このファイルは「新UIと再生エンジンの間の唯一の約束事」を定義する。
 * ここに書いてある形だけを新UIは知っていればよく、YouTube Music が
 * どういう DOM で何を持っているかは一切知らない。
 *
 * 実装は2つある。どちらも同じ契約を満たす。
 *   - mock-adapter.js … モックデータ。プロトタイプと契約テストで使う
 *   - ytm-adapter.js  … 実機（Phase 6c で実装）
 *
 * 設計の根拠は prototype/now-playing/SPEC.md の §7 と docs/ADAPTER-CONTRACT.md。
 * **矛盾した状態を型で表現できないようにする**のがこのファイルの目的である。
 *
 * このファイルは純粋である。DOM・chrome API・タイマーに触らない。
 */

/* ------------------------------------------------------------------ *
 * 定数
 * ------------------------------------------------------------------ */

/**
 * リピートは3状態。2状態トグルで設計しない。
 * 値は YouTube Music の `ytmusic-player-bar.repeatMode` の実測値に合わせてある
 * （docs/YTM-INTERNALS.md §4.1）。
 */
export const REPEAT_MODES = Object.freeze(['NONE', 'ALL', 'ONE']);

/**
 * 再生状態は「単一の列挙」である。
 *
 * プロトタイプは mediaPaused / playing / buffering の真偽値3つを持っていたが、
 * 8通りのうち5通りがあり得ない組み合わせで、型がそれを許してしまっていた
 * （SPEC.md §7 の指摘4）。
 *
 * YouTube Music 側には実測で意味の違う3つのソースがある
 * （docs/YTM-INTERNALS.md §4.3）。どれを信じるかの判断は Adapter の内側に閉じ、
 * UI へはこの1つの値だけを見せる。
 *
 *   video.paused        … ユーザーが止めたか
 *   bar.playing         … 再生ボタンの見た目
 *   getPlayerState()===3 … バッファリング中
 *
 *   idle      … 曲がまだ特定できていない
 *   playing   … 再生位置が進んでいる
 *   buffering … 再生の意図はあるが位置が進んでいない
 *   paused    … ユーザーが止めた
 *   ended     … 曲の末尾に到達して止まっている
 */
export const PLAYBACK_STATUS = Object.freeze(['idle', 'playing', 'buffering', 'paused', 'ended']);

/** 歌詞の取得状態。`empty`（歌詞が存在しない）と `error`（取りに行って失敗）は別物。 */
export const LYRICS_STATUS = Object.freeze(['idle', 'loading', 'ready', 'empty', 'error']);

/** 翻訳の取得状態。歌詞本体とは独立して進む。 */
export const TRANSLATION_STATUS = Object.freeze(['idle', 'loading', 'ready', 'error']);

/** キューの取得状態。 */
export const QUEUE_STATUS = Object.freeze(['idle', 'loading', 'ready', 'error']);

/**
 * 評価（いいね／低評価）。3状態である。
 *
 * PiP には以前から評価の表示と操作があり、YouTube Music の DOM を直接クリックしていた
 * （`src/js/module/pip-manager.js`、ROADMAP 4c #1）。Phase 6c でそれを Adapter の内側へ
 * 移すと決めているのに、Phase 6a の契約には評価がどこにも無く、**移し先が存在しなかった**
 * （2026-09-07 Codex レビュー 高2）。
 *
 * 契約の方針どおり `toggleLike()` ではなく**目標値指定**（`setLikeStatus`）にしてある。
 * YouTube Music 側の実体はトグルなので、その変換は Adapter の内側でやる（§3.6 と同じ）。
 */
export const LIKE_STATUSES = Object.freeze(['none', 'like', 'dislike']);

/**
 * 操作が失敗した理由。
 *   unsupported … この環境ではその操作ができない（capabilities が false）
 *   not-found   … 対象が見つからない（消えたキュー項目など）
 *   timeout     … 目標値に届いたことを確認できなかった
 *   rejected    … 再生エンジンが拒否した
 */
export const OP_FAILURES = Object.freeze(['unsupported', 'not-found', 'timeout', 'rejected']);

/** 音量スケールの上限。**YTM スケール（0〜100）である。** `video.volume` の 0〜1 と混ぜない。 */
export const VOLUME_MAX = 100;

/* ------------------------------------------------------------------ *
 * 型（JSDoc）
 * ------------------------------------------------------------------ */

/**
 * @typedef {'NONE'|'ALL'|'ONE'} RepeatMode
 * @typedef {'idle'|'playing'|'buffering'|'paused'|'ended'} PlaybackStatus
 * @typedef {'idle'|'loading'|'ready'|'empty'|'error'} LyricsStatus
 * @typedef {'idle'|'loading'|'ready'|'error'} TranslationStatus
 * @typedef {'idle'|'loading'|'ready'|'error'} QueueStatus
 * @typedef {'unsupported'|'not-found'|'timeout'|'rejected'} OpFailure
 * @typedef {'none'|'like'|'dislike'} LikeStatus
 */

/**
 * 曲の参照。**「いま鳴っている曲そのもの」だけを表す。**
 *
 * **キュー所属（itemId）はここに持たせない。** 正本は `QueueSnapshot.currentItemId` である。
 * TrackRef が itemId を必須で持っていると、次の状態を型で表現できなかった
 * （2026-09-07 Codex レビュー 高1）。
 *
 *   - 曲は特定できたが、キューはまだ取得中
 *   - MAIN world のブリッジが落ちて `capabilities.queue === false`
 *   - 再生中の項目が、取得済みキューにまだ現れていない
 *
 * このとき架空の itemId を作るか、取れている曲情報ごと `track: null` にするしかなく、
 * 後者では曲名・再生・歌詞まで不必要に消える。**曲とキュー所属は別の関心である。**
 *
 *   - instanceId … 「この再生」を指す。曲変更の検知に使う
 *   - videoId    … 曲そのもの。歌詞取得のキーに使う
 *   - キュー所属  … `queue.currentItemId`。取れないときは null
 *
 * ### instanceId とは何か
 *
 * **Adapter が「曲の再生を新しく開始した」と判断するたびに変わる不透明な値**である。
 * UI は等値比較しかしない。次送り・前送り・選曲・自動送り・リピートONEの折り返しで変わる。
 *
 * これをキュー項目IDと分けているのには実利がある。Phase 6b の実測でキューに安定IDが
 * 無いと分かった場合、`videoId#index` の合成IDへ落とすことになるが、そのIDは
 * **並べ替えのたびに変わる。** 曲変更の検知をそれに乗せていると、曲は変わっていないのに
 * UI が「曲が変わった」と誤認して追従や読み上げをやり直す。instanceId ならその影響を受けない。
 *
 * 配列インデックス（旧 trackIndex）は使わない。実キューは挿入・削除・
 * 並べ替えがあるので、位置は次の瞬間には別の曲を指す（SPEC.md §7 の指摘2）。
 *
 * @typedef {object} TrackRef
 * @property {string} instanceId  この再生を指す不透明な値。曲変更の検知に使う
 * @property {string} videoId
 * @property {string} title
 * @property {string} artist
 * @property {string} album
 * @property {string|null} artworkUrl
 * @property {Palette|null} palette  抽出色。未抽出なら null（UI は既定色へ落とす）
 */

/**
 * 配色。UI 用と背景用で系統が違うので分けてある。
 * 背景は5色すべてを必須で読む（SPEC.md §1）。
 *
 * @typedef {object} Palette
 * @property {{primary: string, secondary: string, shadow: string}} ui
 * @property {{base: string, spot0: string, spot1: string, spot2: string, spot3: string}} background
 */

/**
 * 再生の状態。
 *
 * `position` はこのスナップショットを作った瞬間の**標本値**である。
 * 毎フレームの現在位置は `getPosition()` で取ること（下記 PlayerAdapter を参照）。
 *
 * @typedef {object} Playback
 * @property {PlaybackStatus} status
 * @property {number} position           秒。曲内ローカル時間（時刻補正適用済み）
 * @property {number|null} duration      秒。**不明なら null**（ライブ配信・メタ未取得）
 * @property {number} positionUpdatedAt  position を標本化した時刻（ミリ秒）
 * @property {boolean} seekable          シークできるか
 */

/**
 * この環境で実際にできること。
 *
 * MAIN world のブリッジが死ぬと、音量・リピート・シャッフルの**状態が読めなくなる**
 * （docs/YTM-INTERNALS.md §7.2：DOM 側に言語非依存の手掛かりが皆無）。
 * そのとき該当の capability を false にし、**UI はそのボタンを無効化する。**
 * 押しても何も起きないボタンを黙って出すのが最悪の振る舞いである。
 *
 * @typedef {object} Capabilities
 * @property {boolean} seek
 * @property {boolean} volume
 * @property {boolean} repeat
 * @property {boolean} shuffle
 * @property {boolean} queue
 * @property {boolean} lyrics
 * @property {boolean} translation
 * @property {boolean} like             評価の読み取りと操作ができるか
 * @property {boolean} detectBuffering  buffering を区別できるか。false なら status に buffering が現れない
 */

/**
 * 応答待ちの操作。
 *
 * **UI は操作の成功を仮定しない。** setRepeat('ONE') を呼ぶと、まず
 * pending.repeat === true のスナップショットが来る。YTM 側で確定してから
 * repeat === 'ONE' / pending.repeat === false が来る。
 * UI が自分で状態を書き換えることは一切ない（SPEC.md §7）。
 *
 * @typedef {object} PendingOps
 * @property {boolean} transport  play / pause / next / previous / selectQueueItem
 * @property {boolean} seek
 * @property {boolean} volume     setVolume / setMuted
 * @property {boolean} repeat
 * @property {boolean} shuffle
 * @property {boolean} like
 */

/**
 * @typedef {object} PlayerSnapshot
 * @property {number} revision          単調増加。古い通知を捨てるため
 * @property {TrackRef|null} track      まだ特定できていなければ null
 * @property {Playback} playback
 * @property {number} volume            0〜100（YTM スケール）
 * @property {boolean} muted
 * @property {RepeatMode} repeat
 * @property {boolean} shuffle
 * @property {LikeStatus} likeStatus
 * @property {Capabilities} capabilities
 * @property {PendingOps} pending
 */

/**
 * @typedef {object} QueueItem
 * @property {string} itemId   安定ID。並べ替え・挿入・削除に耐える
 * @property {string} videoId
 * @property {string} title
 * @property {string} artist
 * @property {string|null} artworkUrl
 */

/**
 * キュー。`Track[]` と `trackIndex` の組は使わない（SPEC.md §7 の指摘1・2）。
 *
 * **`currentItemId` が「現在曲がキューのどの項目か」の唯一の正本である。**
 * `TrackRef` 側には持たせない（TrackRef の説明を参照）。
 * キューが取得中・取得できない・現在曲がまだキューに現れていないときは null になる。
 * **null は異常ではなく正常な状態**であり、そのあいだ UI はキューの現在行を
 * 強調しないだけで、曲名・再生・歌詞はふつうに出せる。
 *
 * @typedef {object} QueueSnapshot
 * @property {QueueStatus} status
 * @property {QueueItem[]} items
 * @property {string|null} currentItemId  取得できていなければ null
 * @property {string|null} error
 */

/**
 * @typedef {object} LyricLine
 * @property {string} id   行の安定ID
 * @property {number} at   秒。曲内ローカル時間。**時刻補正は適用済みで渡る**
 * @property {string} text
 */

/**
 * 翻訳。歌詞本体とは独立した取得状態を持つ。
 *
 * 訳文を LyricLine の中に入れないのは、翻訳が届くたびに lines 配列を
 * 作り直すことになり、UI 側が「歌詞が変わった」と誤認して歌詞 DOM を
 * 丸ごと再構築してしまうためである（SPEC.md §7）。
 *
 * @typedef {object} TranslationSnapshot
 * @property {TranslationStatus} status
 * @property {Record<string, string>} byLineId  行ID → 訳文
 * @property {string|null} error
 */

/**
 * 歌詞。
 *
 * **videoId を持たせているのが要点。** 歌詞は非同期で遅れて届くので、
 * 曲が変わった直後に「前の曲の歌詞」が届くことが実際に起きる。
 * UI は lyrics.videoId !== player.track.videoId なら表示しない、で防げる。
 * プロトタイプは Track が歌詞を抱えていたので、この事故が構造的に
 * 起きず、**穴があることに気づけない形**になっていた（SPEC.md §7 の指摘3）。
 *
 * @typedef {object} LyricsSnapshot
 * @property {string|null} videoId  この歌詞がどの曲のものか
 * @property {LyricsStatus} status
 * @property {LyricLine[]} lines
 * @property {string|null} source   'LRCHub' | 'LRCLib' | 'YTM' など。出所表示用
 * @property {string|null} error
 * @property {TranslationSnapshot} translation
 */

/**
 * @typedef {object} AdapterState
 * @property {PlayerSnapshot} player
 * @property {QueueSnapshot} queue
 * @property {LyricsSnapshot} lyrics
 */

/**
 * @typedef {{ok: true}|{ok: false, reason: OpFailure}} OpResult
 */

/**
 * Adapter の契約。実装はこれを満たす。
 *
 * ## 購読の約束
 *
 * - `subscribe(fn)` は**登録した時点で同期的に1回**呼ばれる（初回描画のため）。
 * - 以降は**離散的な変化のときだけ**呼ばれる。曲・再生状態・音量・リピート・
 *   シャッフル・キュー・歌詞・pending・capabilities のいずれかが変わったとき。
 * - **再生位置の進行では呼ばれない。**
 * - 戻り値は解除関数。
 *
 * ## 再生位置を購読で配らない理由（重要）
 *
 * 歌詞の RAF ループは毎フレーム現在位置を必要とする。しかしそのために
 * スナップショット全体を毎フレーム作り直して全購読者へ配るのは無駄である。
 * そこで読み取り経路を2つに分けている。
 *
 *   subscribe()   … 離散変化。スナップショット全体
 *   getPosition() … 毎フレーム。{ position, duration } だけ。通知を発生させない
 *
 * これは Phase 4c #9（`_cachedVideoEl` を RAF が毎フレーム参照している）と
 * 正面から噛み合う。`<video>` 要素の解決・キャッシュ・再取得を Adapter が
 * 引き受け、`getPosition()` がその唯一の窓口になる。ここを分けないと
 * 「新UIが YouTube Music 固有 DOM を直接参照しない」を満たせない。
 *
 * ## 操作の約束
 *
 * - すべて `Promise<OpResult>` を返す。**失敗は例外ではなく戻り値で表す。**
 * - すべて**目標値指定**である。`cycleRepeat()` や `toggleShuffle()` のような
 *   相対操作は置かない。外部（YTM 本体のUI・キーボード）で値が変わると
 *   意図とずれるため（SPEC.md §7 の指摘6）。
 *   YTM 側にトグル操作しか無い場合は、Adapter が内側で
 *   「目標値に届くまで押し、毎回読み直して確認する」変換を行う。
 * - `seekToLyricLine(id)` は**置かない。** UI 側で行IDを秒へ解決してから
 *   `seek(sec)` を出す。Adapter が UI の歌詞行IDを知る必要はない（指摘8）。
 * - 表示切替・追従・コントラスト・動きは**UIローカル状態**であり、
 *   Adapter を経由しない（指摘7）。
 *
 * @typedef {object} PlayerAdapter
 * @property {(listener: (state: AdapterState) => void) => () => void} subscribe
 * @property {() => AdapterState} getState
 * @property {() => {position: number, duration: number|null}} getPosition
 * @property {() => Promise<OpResult>} play
 * @property {() => Promise<OpResult>} pause
 * @property {(seconds: number) => Promise<OpResult>} seek
 * @property {() => Promise<OpResult>} next
 * @property {() => Promise<OpResult>} previous
 * @property {(itemId: string) => Promise<OpResult>} selectQueueItem
 * @property {(value: number) => Promise<OpResult>} setVolume
 * @property {(muted: boolean) => Promise<OpResult>} setMuted
 * @property {(mode: RepeatMode) => Promise<OpResult>} setRepeat
 * @property {(enabled: boolean) => Promise<OpResult>} setShuffle
 * @property {(status: LikeStatus) => Promise<OpResult>} setLikeStatus
 * @property {(enabled: boolean) => Promise<OpResult>} setTranslationWanted
 * @property {() => Promise<OpResult>} reloadLyrics
 * @property {() => void} destroy
 */

/** 契約が要求するメソッド名の全量。契約テストと実装の両方がこれを見る。 */
export const ADAPTER_METHODS = Object.freeze([
  'subscribe', 'getState', 'getPosition',
  'play', 'pause', 'seek', 'next', 'previous', 'selectQueueItem',
  'setVolume', 'setMuted', 'setRepeat', 'setShuffle', 'setLikeStatus',
  'setTranslationWanted', 'reloadLyrics', 'destroy',
]);

/* ------------------------------------------------------------------ *
 * 純粋なヘルパ
 * ------------------------------------------------------------------ */

/** @returns {OpResult} */
export const ok = () => ({ ok: true });

/** @param {OpFailure} reason @returns {OpResult} */
export const fail = (reason) => ({ ok: false, reason });

/** 音量を YTM スケール（0〜100 の整数）へ丸める。 */
export const clampVolume = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(VOLUME_MAX, Math.round(numeric)));
};

/** @returns {value is RepeatMode} */
export const isRepeatMode = (value) => REPEAT_MODES.includes(value);

/** @returns {value is LikeStatus} */
export const isLikeStatus = (value) => LIKE_STATUSES.includes(value);

/**
 * スナップショットを**深く**凍結する。
 *
 * 浅い `Object.freeze` だと、入れ子（`track.palette.ui` など）は書き換えられてしまう。
 * 実際に `state.player.track.palette.ui.primary` を書き換えられ、その値が
 * `getState()` に残ることを確認した（2026-09-07 Codex レビュー 低1）。
 * **UI が状態を書き換えられないという約束は、入れ子まで届いて初めて成り立つ。**
 *
 * 「凍結済みなら降りない」判定にしないこと。外側だけ `Object.freeze` した木を渡されたとき、
 * 入れ子を素通りしてしまう。訪問済み集合で二重処理と循環を防ぐ。
 */
export const deepFreeze = (value, seen = new WeakSet()) => {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  Object.freeze(value);
  for (const key of Object.keys(value)) deepFreeze(value[key], seen);
  return value;
};

/** 既定の capabilities。実装が個別に上書きする。 */
export const createCapabilities = (overrides = {}) => Object.freeze({
  seek: true, volume: true, repeat: true, shuffle: true,
  queue: true, lyrics: true, translation: true, like: true, detectBuffering: true,
  ...overrides,
});

/** 応答待ちなしの pending。 */
export const createPendingOps = (overrides = {}) => Object.freeze({
  transport: false, seek: false, volume: false, repeat: false, shuffle: false, like: false,
  ...overrides,
});

/** 何も分かっていない状態の PlayerSnapshot。 */
export const createEmptyPlayerSnapshot = () => Object.freeze({
  revision: 0,
  track: null,
  playback: Object.freeze({
    status: 'idle', position: 0, duration: null, positionUpdatedAt: 0, seekable: false,
  }),
  volume: 0,
  muted: false,
  repeat: 'NONE',
  shuffle: false,
  likeStatus: 'none',
  capabilities: createCapabilities(),
  pending: createPendingOps(),
});

/** 何も分かっていない状態の QueueSnapshot。 */
export const createEmptyQueueSnapshot = () => Object.freeze({
  status: 'idle', items: Object.freeze([]), currentItemId: null, error: null,
});

/** 何も分かっていない状態の LyricsSnapshot。 */
export const createEmptyLyricsSnapshot = () => Object.freeze({
  videoId: null,
  status: 'idle',
  lines: Object.freeze([]),
  source: null,
  error: null,
  translation: Object.freeze({ status: 'idle', byLineId: Object.freeze({}), error: null }),
});

/** 何も分かっていない状態の AdapterState。 */
export const createEmptyAdapterState = () => Object.freeze({
  player: createEmptyPlayerSnapshot(),
  queue: createEmptyQueueSnapshot(),
  lyrics: createEmptyLyricsSnapshot(),
});

/**
 * 歌詞スナップショットが「今の曲のもの」かどうか。
 *
 * 非同期で遅れて届いた前の曲の歌詞を表示しないための判定。
 * UI はこれが false の間、歌詞領域を取得中として扱えばよい。
 */
export const lyricsMatchTrack = (lyrics, track) => (
  !!lyrics && !!track && lyrics.videoId === track.videoId
);

/**
 * 秒を "m:ss" にする。UI が複数箇所で同じ整形を必要とするのでここに置く。
 * duration が null（曲長不明）のときは "--:--"。
 */
export const formatTime = (seconds) => {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--';
  const total = Math.floor(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};
