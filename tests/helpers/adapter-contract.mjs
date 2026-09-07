/**
 * Player Adapter 契約テストの本体。
 *
 * **1本のテストを MockAdapter と YtmAdapter の両方に当てる**ためにここへ切り出してある。
 * 「モックと実プレイヤーで同じ状態インターフェースを使える」という
 * Phase 6 の完了条件は、これが両方で通ることで証明される。
 *
 * このフォルダは `node --test tests/*.mjs` のグロブに入らない（tests/helpers/ 配下のため）。
 * ここに test() を書かないこと。呼び出し側のテストファイルから runAdapterContract() を呼ぶ。
 *
 * 既存テスト9本のような「ソースを正規表現で検査する」方式にはしていない。
 * あの方式は関数名を変えただけで壊れるのでリファクタリングの安全網にならない
 * （private-docs/HANDOFF.md §6）。ここでは実際に動かして振る舞いを見る。
 */

import assert from 'node:assert/strict';
import { ADAPTER_METHODS, REPEAT_MODES, lyricsMatchTrack } from '../../src/js/newui/adapter/types.js';

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

/**
 * 契約テスト本体。
 *
 * @param {object} api  呼び出し側が渡す道具一式
 * @param {(name: string, fn: () => any) => void} api.test  テストランナーの test()
 * @param {string} api.label  実装の名前（失敗メッセージ用）
 * @param {(overrides?: object) => import('../../src/js/newui/adapter/types.js').PlayerAdapter} api.createAdapter
 *   毎回まっさらな Adapter を作る。overrides は実装固有の設定
 */
export function runAdapterContract({ test, label, createAdapter }) {
  const name = (text) => `[${label}] ${text}`;

  /** 生成したアダプタを必ず片付けるための小道具。 */
  const withAdapter = (fn) => async () => {
    const adapter = createAdapter();
    try { await fn(adapter); } finally { adapter.destroy(); }
  };

  /* ---------------- 形 ---------------- */

  test(name('契約が要求するメソッドをすべて持つ'), withAdapter((adapter) => {
    for (const method of ADAPTER_METHODS) {
      assert.equal(typeof adapter[method], 'function', `${method} が無い`);
    }
  }));

  test(name('getState はスナップショット3つを返し、凍結されている'), withAdapter((adapter) => {
    const state = adapter.getState();
    for (const key of ['player', 'queue', 'lyrics']) {
      assert.ok(state[key], `${key} が無い`);
    }
    // UI が状態を書き換えられないことを型ではなく実物で保証する。
    assert.ok(Object.isFrozen(state), 'state が凍結されていない');
    assert.ok(Object.isFrozen(state.player), 'player が凍結されていない');
    assert.ok(Object.isFrozen(state.player.playback), 'playback が凍結されていない');
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
    await wait(120);
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
    const statuses = new Set(['idle', 'playing', 'buffering', 'paused', 'ended']);
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
    await wait(120);
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

  /* ---------------- キュー ---------------- */

  test(name('キュー項目は安定IDを持ち、配列インデックスに依存しない'), withAdapter(async (adapter) => {
    const { queue } = adapter.getState();
    assert.ok(queue.items.length >= 2, 'テストにはキュー項目が2つ以上必要');
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

  test(name('現在曲は itemId で指され、キュー項目と対応する'), withAdapter(async (adapter) => {
    const state = adapter.getState();
    assert.equal(state.player.track.itemId, state.queue.currentItemId);
    assert.ok(state.queue.items.some(i => i.itemId === state.queue.currentItemId));
  }));

  test(name('selectQueueItem は itemId で選曲する'), withAdapter(async (adapter) => {
    const target = adapter.getState().queue.items[1];
    const result = await adapter.selectQueueItem(target.itemId);
    assert.equal(result.ok, true);
    assert.equal(adapter.getState().queue.currentItemId, target.itemId);
    assert.equal(adapter.getState().player.track.itemId, target.itemId);
  }));

  test(name('同じ videoId の項目が2つあっても itemId で区別できる'), withAdapter(async (adapter) => {
    const items = adapter.getState().queue.items;
    const duplicated = items.filter(i => i.videoId === items[0].videoId);
    if (duplicated.length < 2) return;   // 重複を用意していない実装では検査しない
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
      { label: 'lyrics settle' },
    );
    const state = adapter.getState();
    assert.equal(state.lyrics.videoId, state.player.track.videoId);
    assert.equal(lyricsMatchTrack(state.lyrics, state.player.track), true);
  }));

  test(name('曲を変えると歌詞は取得中から始まり、前の曲の歌詞を残さない'), withAdapter(async (adapter) => {
    await waitFor(() => adapter.getState().lyrics.status !== 'loading', { label: 'initial lyrics' });
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
    await waitFor(() => adapter.getState().lyrics.status !== 'loading', { label: 'lyrics settle' });
    const state = adapter.getState();
    assert.equal(
      state.lyrics.videoId, state.player.track.videoId,
      '歌詞が現在曲と食い違っている',
    );
  }));

  test(name('歌詞の取得状態に empty と error の区別がある'), withAdapter(async (adapter) => {
    const statuses = new Set(['idle', 'loading', 'ready', 'empty', 'error']);
    assert.ok(statuses.has(adapter.getState().lyrics.status));
  }));

  /* ---------------- 翻訳 ---------------- */

  test(name('翻訳は歌詞本体と独立した取得状態を持つ'), withAdapter(async (adapter) => {
    await waitFor(() => adapter.getState().lyrics.status === 'ready', { label: 'lyrics ready' });
    assert.equal(adapter.getState().lyrics.translation.status, 'idle');
    await adapter.setTranslationWanted(true);
    await waitFor(
      () => adapter.getState().lyrics.translation.status === 'ready',
      { label: 'translation ready' },
    );
    const state = adapter.getState();
    // 歌詞本体は ready のまま。翻訳の到着で歌詞が作り直されていないこと
    assert.equal(state.lyrics.status, 'ready');
    assert.ok(Object.keys(state.lyrics.translation.byLineId).length > 0, '訳文が空');
  }));

  test(name('訳文は行の中ではなく行IDの対応表で持つ'), withAdapter(async (adapter) => {
    await waitFor(() => adapter.getState().lyrics.status === 'ready', { label: 'lyrics ready' });
    await adapter.setTranslationWanted(true);
    await waitFor(
      () => adapter.getState().lyrics.translation.status === 'ready',
      { label: 'translation ready' },
    );
    const { lines, translation } = adapter.getState().lyrics;
    for (const line of lines) {
      assert.equal(line.translation, undefined, 'LyricLine が訳文を抱えている');
    }
    assert.ok(lines.some(line => translation.byLineId[line.id]), '行IDで訳文を引けない');
  }));

  test(name('翻訳を切ると訳文の取得状態が idle へ戻る'), withAdapter(async (adapter) => {
    await waitFor(() => adapter.getState().lyrics.status === 'ready', { label: 'lyrics ready' });
    await adapter.setTranslationWanted(true);
    await waitFor(() => adapter.getState().lyrics.translation.status === 'ready', { label: 'translation' });
    await adapter.setTranslationWanted(false);
    assert.equal(adapter.getState().lyrics.translation.status, 'idle');
  }));

  /* ---------------- capabilities ---------------- */

  test(name('capabilities が全項目そろっている'), withAdapter((adapter) => {
    const caps = adapter.getState().player.capabilities;
    for (const key of ['seek', 'volume', 'repeat', 'shuffle', 'queue', 'lyrics', 'translation', 'detectBuffering']) {
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
