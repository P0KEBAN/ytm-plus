/**
 * Player Adapter 契約テストの本体。
 *
 * このフォルダは `node --test tests/*.mjs` のグロブに入らない（tests/helpers/ 配下のため）。
 * ここに test() を書かないこと。呼び出し側のテストファイルから runAdapterContract() を呼ぶ。
 *
 * 既存テスト9本のような「ソースを正規表現で検査する」方式にはしていない。
 * あの方式は関数名を変えただけで壊れるのでリファクタリングの安全網にならない
 * （private-docs/HANDOFF.md §6）。ここでは実際に動かして振る舞いを見る。
 *
 * ## ★ これは「実機に当てるテスト」ではない（2026-09-07 Codex レビュー 高3）
 *
 * Phase 6a では「同じ本体を YtmAdapter にも当てれば、モックと実プレイヤーで同じ
 * インターフェースを使えることの証明になる」と書いていた。**これは成り立たない。**
 * 下の PRECONDITIONS が示すとおり、この本体は
 *
 *   - キューを自由に組める
 *   - 音量・リピート・シャッフル・評価・再生中の曲を**実際に書き換えてよい**
 *   - 歌詞と翻訳が決められた時間内に必ず ready になる
 *
 * という**制御可能なバックエンド**を前提にしている。動いている YouTube Music へ
 * 直接当てれば、非決定的になるうえに利用者の設定を書き換えてしまう。
 *
 * そこでテストは2層に分ける。
 *
 * | 層 | 対象 | 何を証明するか | いつ |
 * | --- | --- | --- | --- |
 * | 契約・状態遷移（この本体） | MockAdapter / 偽 YTM バックエンド上の YtmAdapter | 契約の形と状態遷移が同じであること | Phase 6c |
 * | 実機統合（別物） | 実機の YtmAdapter | MAIN world 往復・実 DOM 接続・タイムアウト・曲変更・timeOffset | Phase 6d |
 *
 * **この本体が YtmAdapter で通っても、実 DOM に繋がっている証明にはならない。**
 * 偽バックエンドは `bar` / `<video>` / キュー DOM を差し替えたものであり、
 * 実機との接続は 6d の統合確認（手順は private-docs 側に置く）で別に確かめる。
 */

import assert from 'node:assert/strict';
import {
  ADAPTER_METHODS, REPEAT_MODES, LIKE_STATUSES, PLAYBACK_STATUS, LYRICS_STATUS,
  lyricsMatchTrack,
} from '../../src/js/newui/adapter/types.js';

/** この本体が実装に要求する前提。満たせない実装にはそのまま当てられない。 */
export const PRECONDITIONS = Object.freeze([
  'キュー項目が2件以上ある',
  '同じ videoId を持つキュー項目が2件ある（安定IDの検査に要る）',
  '音量・リピート・シャッフル・評価・再生中の曲をテストから変更してよい',
  '再生すると positionAdvanceMs 以内に再生位置が進む',
  '歌詞が settleTimeoutMs 以内に ready になり、行が1行以上ある',
  '翻訳が settleTimeoutMs 以内に ready になり、訳文が1件以上ある',
]);

/** 指定ミリ秒待つ。タイマー起因の確定を待つためだけに使う。 */
export const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/** 条件が真になるまで待つ。真にならなければ失敗させる。 */
export async function waitFor(predicate, { timeout = 1500, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await wait(10);
  }
  assert.fail(`timed out waiting for ${label}`);
}

/** 入れ子まで含めて凍結されているかを確かめる。 */
function assertDeeplyFrozen(value, path = 'state') {
  if (value === null || typeof value !== 'object') return;
  assert.ok(Object.isFrozen(value), `${path} が凍結されていない`);
  for (const key of Object.keys(value)) assertDeeplyFrozen(value[key], `${path}.${key}`);
}

/**
 * 契約テスト本体。
 *
 * @param {object} api  呼び出し側が渡す道具一式
 * @param {(name: string, fn: () => any) => void} api.test  テストランナーの test()
 * @param {string} api.label  実装の名前（失敗メッセージ用）
 * @param {(overrides?: object) => import('../../src/js/newui/adapter/types.js').PlayerAdapter} api.createAdapter
 *   毎回まっさらな Adapter を作る。overrides は実装固有の設定。**上の PRECONDITIONS を満たすこと。**
 * @param {number} [api.positionAdvanceMs]  再生位置が進むことを確かめるための待ち時間
 * @param {number} [api.settleTimeoutMs]    歌詞・翻訳の取得を待つ上限
 */
export function runAdapterContract({
  test, label, createAdapter,
  positionAdvanceMs = 120,
  settleTimeoutMs = 1500,
}) {
  const name = (text) => `[${label}] ${text}`;
  const settle = { timeout: settleTimeoutMs };

  /** 生成したアダプタを必ず片付けるための小道具。 */
  const withAdapter = (fn) => async () => {
    const adapter = createAdapter();
    try { await fn(adapter); } finally { adapter.destroy(); }
  };

  /* ---------------- 前提 ---------------- */

  // 前提を満たさない実装に当てたとき、**黙って素通りせずここで落ちる**ようにする。
  // 以前は「重複 videoId が無ければ検査しない」のように静かに諦める書き方があり、
  // 別実装へ当てたときに通ったように見えてしまう穴になっていた。
  test(name('契約テストの前提を満たしている'), withAdapter(async (adapter) => {
    const { queue } = adapter.getState();
    assert.ok(queue.items.length >= 2, `前提: ${PRECONDITIONS[0]}`);
    const counts = new Map();
    for (const item of queue.items) counts.set(item.videoId, (counts.get(item.videoId) || 0) + 1);
    assert.ok([...counts.values()].some(n => n >= 2), `前提: ${PRECONDITIONS[1]}`);
    await waitFor(() => adapter.getState().lyrics.status === 'ready',
      { ...settle, label: `前提: ${PRECONDITIONS[4]}` });
    assert.ok(adapter.getState().lyrics.lines.length > 0, `前提: ${PRECONDITIONS[4]}`);
  }));

  /* ---------------- 形 ---------------- */

  test(name('契約が要求するメソッドをすべて持つ'), withAdapter((adapter) => {
    for (const method of ADAPTER_METHODS) {
      assert.equal(typeof adapter[method], 'function', `${method} が無い`);
    }
  }));

  test(name('getState はスナップショット3つを返し、入れ子まで凍結されている'), withAdapter((adapter) => {
    const state = adapter.getState();
    for (const key of ['player', 'queue', 'lyrics']) {
      assert.ok(state[key], `${key} が無い`);
    }
    // UI が状態を書き換えられないことを型ではなく実物で保証する。
    // 浅い freeze では track.palette.ui が書き換えられてしまう実績がある。
    assertDeeplyFrozen(state);
  }));

  test(name('パレットも書き換えられない'), withAdapter((adapter) => {
    const palette = adapter.getState().player.track.palette;
    if (!palette) return;   // パレット未抽出は正常な状態
    const before = palette.ui.primary;
    assert.throws(() => { palette.ui.primary = '#ff0000'; },
      'palette.ui が書き換えられる');
    assert.equal(adapter.getState().player.track.palette.ui.primary, before);
  }));

  test(name('revision は通知のたびに単調増加する'), withAdapter(async (adapter) => {
    const revisions = [];
    adapter.subscribe(state => revisions.push(state.player.revision));
    await adapter.play();
    await adapter.setVolume(33);
    await adapter.setRepeat('ALL');
    assert.ok(revisions.length >= 2, '通知が発生していない');
    for (let i = 1; i < revisions.length; i += 1) {
      assert.ok(revisions[i] > revisions[i - 1],
        `revision が増えていない: ${revisions[i - 1]} → ${revisions[i]}`);
    }
  }));

  /* ---------------- 購読 ---------------- */

  test(name('subscribe は登録時に同期的に1回呼ばれる'), withAdapter((adapter) => {
    const seen = [];
    const unsubscribe = adapter.subscribe(state => seen.push(state));
    assert.equal(seen.length, 1, '同期的な初回呼び出しが無い');
    assert.equal(seen[0], adapter.getState());
    unsubscribe();
  }));

  test(name('unsubscribe 後は通知が来ない'), withAdapter(async (adapter) => {
    let count = 0;
    const unsubscribe = adapter.subscribe(() => { count += 1; });
    unsubscribe();
    const before = count;
    await adapter.setRepeat('ALL');
    assert.equal(count, before, '解除後に通知が来ている');
  }));

  test(name('再生位置が進むだけでは通知が発生しない'), withAdapter(async (adapter) => {
    await adapter.play();
    let count = 0;
    adapter.subscribe(() => { count += 1; });
    const baseline = count;              // 初回同期呼び出し分
    const startPosition = adapter.getPosition().position;
    await wait(positionAdvanceMs);
    // 位置は進んでいるのに
    assert.ok(
      adapter.getPosition().position > startPosition,
      '再生中なのに位置が進んでいない',
    );
    // 通知は増えていない
    assert.equal(count, baseline, '位置の進行で通知が発生している');
  }));

  test(name('getPosition は position と duration を返す'), withAdapter((adapter) => {
    const { position, duration } = adapter.getPosition();
    assert.equal(typeof position, 'number');
    assert.ok(duration === null || typeof duration === 'number');
  }));

  /* ---------------- 再生状態 ---------------- */

  test(name('再生状態は単一の列挙で、矛盾する組み合わせを表現できない'), withAdapter(async (adapter) => {
    const statuses = new Set(PLAYBACK_STATUS);
    assert.ok(statuses.has(adapter.getState().player.playback.status));
    await adapter.play();
    assert.equal(adapter.getState().player.playback.status, 'playing');
    await adapter.pause();
    assert.equal(adapter.getState().player.playback.status, 'paused');
    // 旧プロトタイプの mediaPaused / playing / buffering は存在しない
    for (const gone of ['mediaPaused', 'playing', 'buffering']) {
      assert.equal(
        adapter.getState().player.playback[gone], undefined,
        `${gone} が残っている。真偽値3つの設計へ戻っている`,
      );
    }
  }));

  test(name('一時停止すると位置が進まない'), withAdapter(async (adapter) => {
    await adapter.play();
    await wait(60);
    await adapter.pause();
    const stopped = adapter.getPosition().position;
    await wait(positionAdvanceMs);
    assert.equal(adapter.getPosition().position, stopped, '停止中なのに位置が進んでいる');
  }));

  /* ---------------- 操作の応答 ---------------- */

  test(name('操作は Promise<OpResult> を返し、失敗は例外ではなく戻り値'), withAdapter(async (adapter) => {
    const result = await adapter.play();
    assert.equal(result.ok, true);
    const bad = await adapter.selectQueueItem('存在しないID');
    assert.equal(bad.ok, false, '存在しない項目の選曲が成功している');
    assert.equal(bad.reason, 'not-found');
  }));

  test(name('操作中は pending が立ち、確定すると降りる'), withAdapter(async (adapter) => {
    const pendings = [];
    adapter.subscribe(state => pendings.push(state.player.pending.repeat));
    const promise = adapter.setRepeat('ALL');
    assert.ok(pendings.includes(true), 'pending が一度も立っていない');
    await promise;
    assert.equal(adapter.getState().player.pending.repeat, false, 'pending が降りていない');
  }));

  test(name('操作が失敗しても pending は必ず降りる'), withAdapter(async (adapter) => {
    const result = await adapter.selectQueueItem('存在しないID');
    assert.equal(result.ok, false);
    assert.equal(adapter.getState().player.pending.transport, false,
      '失敗した操作の pending が残っている');
  }));

  test(name('同種の操作が重なっているあいだ pending は立ったまま'), withAdapter(async (adapter) => {
    // 先に出した操作が終わった時点で「待機なし」と報告してはならない。
    // 真偽値で持っていると、後続が残っているのに pending が降りる。
    //
    // `await` の後で getState() を見る書き方だと、遅延0の実装では
    // 2件目の確定まで進んでしまい race になる。**通知の列**を見て判定する。
    const seen = [];
    adapter.subscribe(state => seen.push({
      volume: state.player.volume, pending: state.player.pending.volume,
    }));
    const first = adapter.setVolume(11);
    const second = adapter.setVolume(77);
    await Promise.all([first, second]);
    // 1件目が反映された時点のスナップショット（2件目はまだ応答待ち）
    const afterFirst = seen.find(s => s.volume === 11 && seen.indexOf(s) > 0);
    assert.ok(afterFirst, '1件目が反映された時点の通知が来ていない');
    assert.equal(afterFirst.pending, true, '後続の操作が残っているのに pending が降りている');
    assert.equal(adapter.getState().player.pending.volume, false, '最後まで pending が降りない');
    assert.equal(adapter.getState().player.volume, 77, '後から出した操作が反映されていない');
  }));

  test(name('destroy すると応答待ちの操作も必ず完了する'), async () => {
    const adapter = createAdapter();
    let settled = false;
    const promise = adapter.setRepeat('ALL').then((result) => { settled = true; return result; });
    adapter.destroy();
    const result = await Promise.race([promise, wait(300).then(() => 'timeout')]);
    assert.equal(settled, true, 'destroy 後も Promise が pending のまま残っている');
    assert.notEqual(result, 'timeout');
    assert.equal(result.ok, false, 'destroy されたのに成功として完了している');
  });

  /* ---------------- 目標値指定 ---------------- */

  test(name('setRepeat は目標値を指定する。相対操作は契約に無い'), withAdapter(async (adapter) => {
    assert.equal(typeof adapter.cycleRepeat, 'undefined', 'cycleRepeat が残っている');
    for (const mode of REPEAT_MODES) {
      const result = await adapter.setRepeat(mode);
      assert.equal(result.ok, true, `setRepeat(${mode}) が失敗した`);
      assert.equal(adapter.getState().player.repeat, mode);
    }
    // 同じ値を2回指定しても、その値のままであること（相対操作なら進んでしまう）
    await adapter.setRepeat('ALL');
    await adapter.setRepeat('ALL');
    assert.equal(adapter.getState().player.repeat, 'ALL', '同じ目標値の再指定で値が動いた');
  }));

  test(name('setShuffle は目標値を指定する。相対操作は契約に無い'), withAdapter(async (adapter) => {
    assert.equal(typeof adapter.toggleShuffle, 'undefined', 'toggleShuffle が残っている');
    await adapter.setShuffle(true);
    assert.equal(adapter.getState().player.shuffle, true);
    await adapter.setShuffle(true);
    assert.equal(adapter.getState().player.shuffle, true, '同じ目標値の再指定で値が反転した');
    await adapter.setShuffle(false);
    assert.equal(adapter.getState().player.shuffle, false);
  }));

  test(name('setLikeStatus は目標値を指定する。トグルは契約に無い'), withAdapter(async (adapter) => {
    assert.equal(typeof adapter.toggleLike, 'undefined', 'toggleLike が残っている');
    assert.ok(LIKE_STATUSES.includes(adapter.getState().player.likeStatus),
      'likeStatus が列挙の外の値になっている');
    for (const status of LIKE_STATUSES) {
      const result = await adapter.setLikeStatus(status);
      assert.equal(result.ok, true, `setLikeStatus(${status}) が失敗した`);
      assert.equal(adapter.getState().player.likeStatus, status);
    }
    await adapter.setLikeStatus('like');
    await adapter.setLikeStatus('like');
    assert.equal(adapter.getState().player.likeStatus, 'like', '同じ目標値の再指定で値が動いた');
  }));

  test(name('seekToLyricLine は契約に存在しない'), withAdapter((adapter) => {
    assert.equal(typeof adapter.seekToLyricLine, 'undefined');
  }));

  test(name('UIローカル状態の操作は契約に存在しない'), withAdapter((adapter) => {
    for (const gone of ['openQueue', 'closeQueue', 'setHighContrast', 'setMotion', 'resumeLyricFollow']) {
      assert.equal(typeof adapter[gone], 'undefined', `${gone} が Adapter 側に残っている`);
    }
  }));

  /* ---------------- 音量 ---------------- */

  test(name('音量は 0〜100 の整数へ丸められる（YTM スケール）'), withAdapter(async (adapter) => {
    await adapter.setVolume(42.7);
    assert.equal(adapter.getState().player.volume, 43);
    await adapter.setVolume(-30);
    assert.equal(adapter.getState().player.volume, 0);
    await adapter.setVolume(300);
    assert.equal(adapter.getState().player.volume, 100);
    // video.volume の 0〜1 スケールと取り違えていないこと
    await adapter.setVolume(0.8);
    assert.equal(adapter.getState().player.volume, 1, '0〜1 スケールとして解釈されている');
  }));

  test(name('消音は音量の値と独立している'), withAdapter(async (adapter) => {
    await adapter.setVolume(55);
    await adapter.setMuted(true);
    assert.equal(adapter.getState().player.muted, true);
    assert.equal(adapter.getState().player.volume, 55, '消音で音量値まで壊れている');
    await adapter.setMuted(false);
    assert.equal(adapter.getState().player.muted, false);
  }));

  /* ---------------- 曲とキューの分離 ---------------- */

  test(name('TrackRef はキュー所属を持たない。正本は queue.currentItemId'), withAdapter((adapter) => {
    const { track } = adapter.getState().player;
    assert.ok(track, 'この検査には現在曲が要る');
    assert.equal(track.itemId, undefined,
      'TrackRef が itemId を持っている。キュー未取得やブリッジ停止を表現できなくなる');
    assert.equal(typeof track.instanceId, 'string');
    assert.ok(track.instanceId.length > 0, 'instanceId が空');
    assert.equal(typeof track.videoId, 'string');
  }));

  test(name('曲を変えると instanceId が変わる'), withAdapter(async (adapter) => {
    const before = adapter.getState().player.track.instanceId;
    const target = adapter.getState().queue.items
      .find(i => i.itemId !== adapter.getState().queue.currentItemId);
    await adapter.selectQueueItem(target.itemId);
    assert.notEqual(adapter.getState().player.track.instanceId, before,
      '曲を変えたのに instanceId が同じ。UI が曲変更を検知できない');
  }));

  test(name('currentItemId は null になりうるが、非 null ならキュー項目と対応する'), withAdapter((adapter) => {
    const { queue } = adapter.getState();
    assert.ok(queue.currentItemId === null || typeof queue.currentItemId === 'string');
    if (queue.currentItemId !== null && queue.status === 'ready') {
      assert.ok(queue.items.some(i => i.itemId === queue.currentItemId),
        'currentItemId がキューのどの項目とも対応していない');
    }
  }));

  /* ---------------- キュー ---------------- */

  test(name('キュー項目は安定IDを持ち、配列インデックスに依存しない'), withAdapter(async (adapter) => {
    const { queue } = adapter.getState();
    for (const item of queue.items) {
      assert.equal(typeof item.itemId, 'string');
      assert.ok(item.itemId.length > 0, 'itemId が空');
      assert.equal(typeof item.videoId, 'string');
    }
    const ids = queue.items.map(i => i.itemId);
    assert.equal(new Set(ids).size, ids.length, 'itemId が重複している');
    // trackIndex 方式の名残が無いこと
    assert.equal(adapter.getState().player.trackIndex, undefined, 'trackIndex が残っている');
  }));

  test(name('selectQueueItem は itemId で選曲する'), withAdapter(async (adapter) => {
    const target = adapter.getState().queue.items[1];
    const result = await adapter.selectQueueItem(target.itemId);
    assert.equal(result.ok, true);
    assert.equal(adapter.getState().queue.currentItemId, target.itemId);
    assert.equal(adapter.getState().player.track.videoId, target.videoId);
  }));

  test(name('同じ videoId の項目が2つあっても itemId で区別できる'), withAdapter(async (adapter) => {
    const items = adapter.getState().queue.items;
    const counts = new Map();
    for (const item of items) counts.set(item.videoId, [...(counts.get(item.videoId) || []), item]);
    const duplicated = [...counts.values()].find(group => group.length >= 2);
    // 前提で担保しているので、ここに来て見つからないのは実装側の問題。
    assert.ok(duplicated, `前提: ${PRECONDITIONS[1]}`);
    assert.notEqual(duplicated[0].itemId, duplicated[1].itemId, '重複曲の itemId が同じ');
    await adapter.selectQueueItem(duplicated[1].itemId);
    assert.equal(adapter.getState().queue.currentItemId, duplicated[1].itemId);
  }));

  /* ---------------- 歌詞 ---------------- */

  test(name('歌詞は現在曲のぶんだけを持ち、曲が全曲分を抱えない'), withAdapter(async (adapter) => {
    const state = adapter.getState();
    assert.equal(state.player.track.lines, undefined, 'Track が歌詞を持っている');
    assert.ok(Array.isArray(state.lyrics.lines));
    for (const item of state.queue.items) {
      assert.equal(item.lines, undefined, 'キュー項目が歌詞を持っている');
    }
  }));

  test(name('歌詞スナップショットは自分がどの曲のものかを持つ'), withAdapter(async (adapter) => {
    await waitFor(
      () => adapter.getState().lyrics.status !== 'loading',
      { ...settle, label: 'lyrics settle' },
    );
    const state = adapter.getState();
    assert.equal(state.lyrics.videoId, state.player.track.videoId);
    assert.equal(lyricsMatchTrack(state.lyrics, state.player.track), true);
  }));

  test(name('曲を変えると歌詞は取得中から始まり、前の曲の歌詞を残さない'), withAdapter(async (adapter) => {
    await waitFor(() => adapter.getState().lyrics.status !== 'loading',
      { ...settle, label: 'initial lyrics' });
    const first = adapter.getState();
    const target = first.queue.items.find(i => i.itemId !== first.queue.currentItemId);
    await adapter.selectQueueItem(target.itemId);
    const during = adapter.getState();
    // 取得中でも、歌詞が新しい曲のものとして識別できること
    assert.equal(during.lyrics.videoId, target.videoId, '歌詞の videoId が前の曲のまま');
    assert.deepEqual([...during.lyrics.lines], [], '前の曲の歌詞行が残っている');
  }));

  test(name('遅れて届いた前の曲の歌詞が現在曲へ書き込まれない'), withAdapter(async (adapter) => {
    const items = adapter.getState().queue.items;
    // 素早く2回切り替える。1曲目の取得結果が後から届いても採用されてはならない。
    await adapter.selectQueueItem(items[1].itemId);
    await adapter.selectQueueItem(items[0].itemId);
    await waitFor(() => adapter.getState().lyrics.status !== 'loading',
      { ...settle, label: 'lyrics settle' });
    const state = adapter.getState();
    assert.equal(
      state.lyrics.videoId, state.player.track.videoId,
      '歌詞が現在曲と食い違っている',
    );
  }));

  test(name('歌詞の取得状態に empty と error の区別がある'), withAdapter(async (adapter) => {
    assert.ok(new Set(LYRICS_STATUS).has(adapter.getState().lyrics.status));
  }));

  /* ---------------- 翻訳 ---------------- */

  test(name('翻訳は歌詞本体と独立した取得状態を持つ'), withAdapter(async (adapter) => {
    await waitFor(() => adapter.getState().lyrics.status === 'ready',
      { ...settle, label: 'lyrics ready' });
    assert.equal(adapter.getState().lyrics.translation.status, 'idle');
    await adapter.setTranslationWanted(true);
    await waitFor(
      () => adapter.getState().lyrics.translation.status === 'ready',
      { ...settle, label: 'translation ready' },
    );
    const state = adapter.getState();
    // 歌詞本体は ready のまま。翻訳の到着で歌詞が作り直されていないこと
    assert.equal(state.lyrics.status, 'ready');
    assert.ok(Object.keys(state.lyrics.translation.byLineId).length > 0, '訳文が空');
  }));

  test(name('訳文は行の中ではなく行IDの対応表で持つ'), withAdapter(async (adapter) => {
    await waitFor(() => adapter.getState().lyrics.status === 'ready',
      { ...settle, label: 'lyrics ready' });
    await adapter.setTranslationWanted(true);
    await waitFor(
      () => adapter.getState().lyrics.translation.status === 'ready',
      { ...settle, label: 'translation ready' },
    );
    const { lines, translation } = adapter.getState().lyrics;
    for (const line of lines) {
      assert.equal(line.translation, undefined, 'LyricLine が訳文を抱えている');
    }
    assert.ok(lines.some(line => translation.byLineId[line.id]), '行IDで訳文を引けない');
  }));

  test(name('翻訳を切ると訳文の取得状態が idle へ戻る'), withAdapter(async (adapter) => {
    await waitFor(() => adapter.getState().lyrics.status === 'ready',
      { ...settle, label: 'lyrics ready' });
    await adapter.setTranslationWanted(true);
    await waitFor(() => adapter.getState().lyrics.translation.status === 'ready',
      { ...settle, label: 'translation' });
    await adapter.setTranslationWanted(false);
    assert.equal(adapter.getState().lyrics.translation.status, 'idle');
  }));

  test(name('曲を変えると、前の曲の翻訳が新しい曲のスナップショットへ混ざらない'), withAdapter(async (adapter) => {
    await waitFor(() => adapter.getState().lyrics.status === 'ready',
      { ...settle, label: 'lyrics ready' });
    await adapter.setTranslationWanted(true);
    await waitFor(() => adapter.getState().lyrics.translation.status === 'ready',
      { ...settle, label: 'translation ready' });
    const before = adapter.getState().lyrics;
    const target = adapter.getState().queue.items
      .find(i => i.videoId !== before.videoId);
    await adapter.selectQueueItem(target.itemId);
    // 歌詞が取得中のあいだ、翻訳が ready のまま前の曲の訳文を抱えていてはならない。
    const during = adapter.getState().lyrics;
    if (during.status === 'loading') {
      assert.notEqual(during.translation.status, 'ready',
        '歌詞は取得中なのに翻訳だけ ready になっている（前の曲の訳文が残っている）');
    }
    await waitFor(() => adapter.getState().lyrics.status !== 'loading',
      { ...settle, label: 'lyrics settle' });
    const after = adapter.getState();
    for (const lineId of Object.keys(after.lyrics.translation.byLineId)) {
      assert.ok(
        after.lyrics.lines.some(line => line.id === lineId),
        `現在曲に存在しない行IDの訳文が残っている: ${lineId}`,
      );
    }
  }));

  /* ---------------- capabilities ---------------- */

  test(name('capabilities が全項目そろっている'), withAdapter((adapter) => {
    const caps = adapter.getState().player.capabilities;
    for (const key of ['seek', 'volume', 'repeat', 'shuffle', 'queue', 'lyrics', 'translation', 'like', 'detectBuffering']) {
      assert.equal(typeof caps[key], 'boolean', `capabilities.${key} が無い`);
    }
  }));

  /* ---------------- 後片付け ---------------- */

  test(name('destroy 後は通知が来ない'), async () => {
    const adapter = createAdapter();
    let count = 0;
    adapter.subscribe(() => { count += 1; });
    const before = count;
    adapter.destroy();
    await adapter.setRepeat('ONE').catch(() => {});
    await wait(30);
    assert.equal(count, before, 'destroy 後に通知が来ている');
  });
}
