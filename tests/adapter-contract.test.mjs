/**
 * Player Adapter の契約テスト（MockAdapter に対して）。
 *
 * 契約の本体は tests/helpers/adapter-contract.mjs にある。
 * Phase 6c で YtmAdapter を実装したら、**偽の YTM バックエンドの上で**同じ本体を当てる。
 *
 * **実機の YouTube Music へ直接当てるテストではない。** 本体は「キューを自由に組める・
 * 音量やリピートを書き換えてよい・歌詞が決められた時間内に必ず届く」を前提にしていて、
 * 実機に当てれば非決定的になるうえ利用者の設定を書き換えてしまう。
 * 実機との接続（MAIN world 往復・実 DOM・タイムアウト）は Phase 6d の統合確認で別に見る。
 * 経緯は helpers/adapter-contract.mjs の冒頭と docs/ADAPTER-CONTRACT.md §6。
 *
 * このファイルには、それに加えてモック実装固有の検査も置く。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createMockAdapter } from '../src/js/newui/adapter/mock-adapter.js';
import { runAdapterContract, waitFor, wait } from './helpers/adapter-contract.mjs';

/**
 * 契約テスト用のフィクスチャ。
 *
 * 意図的に次を含めてある。
 *  - 同じ videoId を持つ項目を2つ（安定IDの検査用）
 *  - 曲長が null の項目（曲長不明の検査用）
 *  - 歌詞が無い項目、歌詞取得が失敗する項目
 */
const buildFixtures = () => ([
  {
    itemId: 'q1', videoId: 'vid-a', title: '1曲目', artist: 'A', album: 'AA',
    artworkUrl: null, palette: null, duration: 12,
    lines: [
      { id: 'a0', at: 0, text: '一行目' },
      { id: 'a1', at: 4, text: '二行目' },
      { id: 'a2', at: 8, text: '三行目' },
    ],
    lyricsSource: 'MOCK',
    translation: { a0: 'line one', a1: 'line two', a2: 'line three' },
  },
  {
    itemId: 'q2', videoId: 'vid-b', title: '2曲目', artist: 'B', album: 'BB',
    artworkUrl: null, palette: null, duration: 20,
    lines: [{ id: 'b0', at: 0, text: 'ビー' }],
    translation: { b0: 'bee' },
  },
  // q1 と同じ曲がキューに2回入っている状況。videoId だけでは区別できない。
  {
    itemId: 'q3', videoId: 'vid-a', title: '1曲目', artist: 'A', album: 'AA',
    artworkUrl: null, palette: null, duration: 12,
    lines: [{ id: 'a0', at: 0, text: '一行目' }],
  },
  // 曲長が分からない曲（ライブ配信など）
  {
    itemId: 'q4', videoId: 'vid-c', title: '曲長不明', artist: 'C', album: 'CC',
    artworkUrl: null, palette: null, duration: null, lines: [],
  },
  // 歌詞の取得に失敗する曲
  {
    itemId: 'q5', videoId: 'vid-d', title: '歌詞エラー', artist: 'D', album: 'DD',
    artworkUrl: null, palette: null, duration: 30, lyricsFails: true,
  },
]);

const createAdapter = (overrides = {}) => createMockAdapter({
  fixtures: buildFixtures(),
  lyricsDelayMs: 20,
  translationDelayMs: 20,
  ...overrides,
});

// ---- 契約本体 ----
runAdapterContract({ test, label: 'MockAdapter', createAdapter });

// ---- モック実装固有の検査 ----

test('[MockAdapter] 曲長が不明な曲ではシークが unsupported になる', async () => {
  const adapter = createAdapter();
  try {
    await adapter.selectQueueItem('q4');
    const state = adapter.getState();
    assert.equal(state.player.playback.duration, null, '曲長が null になっていない');
    assert.equal(state.player.playback.seekable, false, 'シーク可能と誤って報告している');
    const result = await adapter.seek(5);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'unsupported');
  } finally { adapter.destroy(); }
});

test('[MockAdapter] 歌詞の取得に失敗する曲では status が error になり、empty と区別される', async () => {
  const adapter = createAdapter();
  try {
    await adapter.selectQueueItem('q5');
    await waitFor(() => adapter.getState().lyrics.status !== 'loading', { label: 'lyrics settle' });
    assert.equal(adapter.getState().lyrics.status, 'error');
    assert.ok(adapter.getState().lyrics.error, 'エラー内容が空');

    await adapter.selectQueueItem('q4');   // 歌詞が存在しない曲
    await waitFor(() => adapter.getState().lyrics.status !== 'loading', { label: 'lyrics settle' });
    assert.equal(adapter.getState().lyrics.status, 'empty');
    assert.equal(adapter.getState().lyrics.error, null, 'empty なのにエラーが入っている');
  } finally { adapter.destroy(); }
});

test('[MockAdapter] reloadLyrics は取得中からやり直す', async () => {
  const adapter = createAdapter();
  try {
    await waitFor(() => adapter.getState().lyrics.status === 'ready', { label: 'lyrics ready' });
    await adapter.reloadLyrics();
    assert.equal(adapter.getState().lyrics.status, 'loading', '取得中を経由していない');
    await waitFor(() => adapter.getState().lyrics.status === 'ready', { label: 'lyrics ready again' });
  } finally { adapter.destroy(); }
});

test('[MockAdapter] capabilities が false の操作は unsupported を返す', async () => {
  const adapter = createAdapter({
    capabilities: { volume: false, repeat: false, shuffle: false, like: false, queue: false },
  });
  try {
    assert.equal((await adapter.setVolume(50)).reason, 'unsupported');
    assert.equal((await adapter.setMuted(true)).reason, 'unsupported');
    assert.equal((await adapter.setRepeat('ALL')).reason, 'unsupported');
    assert.equal((await adapter.setShuffle(true)).reason, 'unsupported');
    assert.equal((await adapter.setLikeStatus('like')).reason, 'unsupported');
    assert.equal((await adapter.selectQueueItem('q2')).reason, 'unsupported');
    // 値も変わっていないこと
    assert.equal(adapter.getState().player.repeat, 'NONE');
    assert.equal(adapter.getState().player.shuffle, false);
    assert.equal(adapter.getState().player.likeStatus, 'none');
  } finally { adapter.destroy(); }
});

test('[MockAdapter] 操作の内部処理が例外を投げても rejected として完了し、pending が残らない', async () => {
  const adapter = createAdapter();
  try {
    // Number() の中で投げる値を渡すと、runOp の apply が例外を出す。
    // 失敗は例外ではなく戻り値で表す、という契約が守られていることを確かめる。
    const hostile = { valueOf() { throw new Error('boom'); } };
    const result = await adapter.setVolume(hostile);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'rejected');
    assert.equal(adapter.getState().player.pending.volume, false, 'pending が残っている');
    // 続く操作がふつうに通ること
    assert.equal((await adapter.setVolume(31)).ok, true);
    assert.equal(adapter.getState().player.volume, 31);
  } finally { adapter.destroy(); }
});

test('[MockAdapter] リピート ONE の折り返しでも instanceId は新しくなる', async () => {
  let clock = 0;
  const adapter = createAdapter({ now: () => clock });
  try {
    await adapter.setRepeat('ONE');
    await adapter.play();
    const before = adapter.getState().player.track.instanceId;
    clock += 13_000;                       // 曲長12秒を超える
    await waitFor(() => adapter.getPosition().position < 1, { label: 'wrap to head' });
    assert.notEqual(adapter.getState().player.track.instanceId, before,
      '同じ曲を頭から鳴らし直したのに instanceId が変わっていない');
  } finally { adapter.destroy(); }
});

test('[MockAdapter] リピート ONE では曲末尾で同じ曲の先頭へ戻る', async () => {
  let clock = 0;
  const adapter = createAdapter({ now: () => clock });
  try {
    await adapter.setRepeat('ONE');
    await adapter.play();
    const itemId = adapter.getState().queue.currentItemId;
    clock += 13_000;                       // 曲長12秒を超える
    await waitFor(
      () => adapter.getPosition().position < 1,
      { label: 'wrap to head' },
    );
    assert.equal(adapter.getState().queue.currentItemId, itemId, '別の曲へ移っている');
  } finally { adapter.destroy(); }
});

test('[MockAdapter] リピート NONE では最後の曲の末尾で ended になる', async () => {
  let clock = 0;
  const adapter = createAdapter({ now: () => clock });
  try {
    const last = adapter.getState().queue.items.at(-1);
    await adapter.selectQueueItem(last.itemId);
    await adapter.play();
    // q5 は曲長30秒
    clock += 31_000;
    await waitFor(
      () => adapter.getState().player.playback.status === 'ended',
      { label: 'ended' },
    );
  } finally { adapter.destroy(); }
});

test('[MockAdapter] ended から play すると先頭から再生し直す', async () => {
  let clock = 0;
  const adapter = createAdapter({ now: () => clock });
  try {
    const last = adapter.getState().queue.items.at(-1);
    await adapter.selectQueueItem(last.itemId);
    await adapter.play();
    clock += 31_000;
    await waitFor(() => adapter.getState().player.playback.status === 'ended', { label: 'ended' });
    await adapter.play();
    assert.equal(adapter.getState().player.playback.status, 'playing');
    assert.ok(adapter.getPosition().position < 1, '末尾のままになっている');
  } finally { adapter.destroy(); }
});

test('[MockAdapter] シャッフル ON の次曲は現在曲以外から選ばれる', async () => {
  // 乱数を固定して結果を決定的にする
  const adapter = createAdapter({ random: () => 0.5 });
  try {
    await adapter.setShuffle(true);
    const before = adapter.getState().queue.currentItemId;
    await adapter.next();
    assert.notEqual(adapter.getState().queue.currentItemId, before, '同じ曲が選ばれた');
  } finally { adapter.destroy(); }
});

test('[MockAdapter] autoAdvance:false では位置が進まない（?capture=1 用）', async () => {
  const adapter = createAdapter({ autoAdvance: false });
  try {
    await adapter.play();
    const start = adapter.getPosition().position;
    await wait(120);
    assert.equal(adapter.getPosition().position, start, '固定モードなのに位置が進んでいる');
  } finally { adapter.destroy(); }
});
