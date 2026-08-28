// Daily Replay の書き込み特性を検証する。
//
// 再生中の再生時間更新は5秒おきに走るため、ここで履歴を全件書き戻すと
// 履歴が伸びるほど再生が重くなる（右肩下がりの性能劣化）。進行中の値は
// 単独キー（PENDING_KEY）へ分離し、履歴本体への全件書き戻しは
// 曲の切り替わりと新規記録のときだけに限定する。
//
// このテストはソーステキスト検査ではなく実際に ReplayManager を動かしている。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const replaySource = fs.readFileSync(
  new URL('../src/js/module/replay-manager.js', import.meta.url),
  'utf8',
)

function createHarness({ history = [] } = {}) {
  const store = new Map()
  if (history.length) store.set('ytm_local_history', history)

  // どのキーへ何回書いたかを数える。性能特性の検証に使う。
  const writes = []

  const storage = {
    get: async (k) => (store.has(k) ? store.get(k) : null),
    set: async (k, v) => {
      writes.push(k)
      store.set(k, v)
    },
    remove: async (k) => {
      store.delete(k)
    },
  }

  const video = { paused: false, duration: 180, currentTime: 0 }
  let currentVideoId = 'video-a'
  let metadata = { title: 'Song A', artist: 'Artist A', src: 'https://example.test/a.jpg' }

  const context = {
    storage,
    config: { uiLang: 'ja' },
    t: (key) => key,
    ui: { replayPanel: null },
    document: {
      querySelector: (selector) => (selector === 'video' ? video : null),
      getElementById: () => null,
    },
    getMetadata: () => metadata,
    getCurrentVideoId: () => currentVideoId,
    setInterval: () => 0,
    confirm: () => false,
    alert: () => {},
    console,
    URL,
    Blob: class {},
  }
  vm.createContext(context)
  vm.runInContext(`${replaySource}\nglobalThis.__replay = ReplayManager;`, context)

  return {
    replay: context.__replay,
    store,
    writes,
    video,
    setVideoId: (id) => { currentVideoId = id },
    setMetadata: (value) => { metadata = value },
    countWrites: (key) => writes.filter(k => k === key).length,
  }
}

const buildHistory = (count) => Array.from({ length: count }, (_, i) => ({
  id: `old-${i}`,
  title: `Old ${i}`,
  artist: 'Someone',
  src: '',
  duration: 100,
  lyricLines: 0,
  timestamp: 1_000 + i,
}))

test('再生中の更新は履歴本体を書き換えず、進行中キーだけを書く', async () => {
  const h = createHarness({ history: buildHistory(500) })
  const { replay } = h

  replay.currentVideoId = 'video-a'
  replay.currentPlayTime = 35
  await replay.recordNewPlay()

  const historyWritesAfterRecord = h.countWrites('ytm_local_history')
  assert.equal(historyWritesAfterRecord, 1, '新規記録では履歴本体を1回だけ書く')

  // 5秒おきの更新を20回ぶん再現する
  for (let i = 1; i <= 20; i++) {
    replay.currentPlayTime = 35 + i * 5
    replay.currentLyricLines = i
    await replay.updateDuration()
  }

  assert.equal(
    h.countWrites('ytm_local_history'),
    historyWritesAfterRecord,
    '再生中の更新で履歴本体を書き戻してはいけない',
  )
  assert.equal(h.countWrites('ytm_local_history_pending'), 20)

  // 履歴サイズによらず、書き込む値は1レコードぶんのまま
  const pending = h.store.get('ytm_local_history_pending')
  assert.deepEqual(Object.keys(pending).sort(), ['duration', 'id', 'lyricLines', 'timestamp'])
  assert.equal(pending.duration, 135)
  assert.equal(pending.lyricLines, 20)
})

test('進行中の値は履歴の読み出しにマージされる', async () => {
  const h = createHarness({ history: buildHistory(3) })
  const { replay } = h

  replay.currentVideoId = 'video-a'
  replay.currentPlayTime = 40
  await replay.recordNewPlay()

  replay.currentPlayTime = 95
  replay.currentLyricLines = 12
  await replay.updateDuration()

  // storage 本体はまだ古い値のまま
  const raw = h.store.get('ytm_local_history')
  assert.equal(raw[raw.length - 1].duration, 40)

  // 読み出しでは最新の値が見える
  const merged = await replay.loadHistory()
  assert.equal(merged[merged.length - 1].duration, 95)
  assert.equal(merged[merged.length - 1].lyricLines, 12)

  // マージは読み出し用のコピーであり、本体を汚染しない
  assert.equal(h.store.get('ytm_local_history')[raw.length - 1].duration, 40)
})

test('曲が切り替わると進行中の値が履歴へ確定する', async () => {
  const h = createHarness({ history: buildHistory(3) })
  const { replay } = h

  replay.currentVideoId = 'video-a'
  replay.currentPlayTime = 40
  await replay.recordNewPlay()
  replay.currentPlayTime = 150
  replay.currentLyricLines = 30
  await replay.updateDuration()

  h.setVideoId('video-b')
  await replay.check()

  const stored = h.store.get('ytm_local_history')
  const last = stored[stored.length - 1]
  assert.equal(last.id, 'video-a')
  assert.equal(last.duration, 150, '確定した再生時間が履歴へ反映される')
  assert.equal(last.lyricLines, 30)
  assert.equal(h.store.has('ytm_local_history_pending'), false, '確定後は進行中キーを残さない')
})

test('ブラウザが落ちて残った進行中の値は次回の確定で回収される', async () => {
  const history = buildHistory(2)
  history.push({
    id: 'video-a',
    title: 'Song A',
    artist: 'Artist A',
    src: '',
    duration: 40,
    lyricLines: 3,
    timestamp: 9_999,
  })
  const h = createHarness({ history })
  h.store.set('ytm_local_history_pending', {
    id: 'video-a',
    timestamp: 9_999,
    duration: 175,
    lyricLines: 41,
  })

  // 起動後の最初の check は currentVideoId が null からの遷移になり、確定処理が走る
  await h.replay.check()

  const stored = h.store.get('ytm_local_history')
  assert.equal(stored[stored.length - 1].duration, 175)
  assert.equal(stored[stored.length - 1].lyricLines, 41)
  assert.equal(h.store.has('ytm_local_history_pending'), false)
})

test('確定先が見つからない進行中の値は捨てられ、履歴を壊さない', async () => {
  const h = createHarness({ history: buildHistory(3) })
  h.store.set('ytm_local_history_pending', {
    id: 'video-gone',
    timestamp: 123,
    duration: 999,
    lyricLines: 999,
  })

  const before = JSON.stringify(h.store.get('ytm_local_history'))
  await h.replay.flushPending()

  assert.equal(JSON.stringify(h.store.get('ytm_local_history')), before)
  assert.equal(h.store.has('ytm_local_history_pending'), false)
  assert.equal(h.countWrites('ytm_local_history'), 0, '照合できない場合は履歴を書かない')
})

test('新しい曲の記録前に、直前の曲の進行中の値が確定する', async () => {
  const h = createHarness({ history: buildHistory(1) })
  const { replay } = h

  replay.currentVideoId = 'video-a'
  replay.currentPlayTime = 40
  await replay.recordNewPlay()
  replay.currentPlayTime = 160
  await replay.updateDuration()

  // 曲送りを経ずに次の記録が走る場合でも取りこぼさない
  replay.currentVideoId = 'video-b'
  replay.currentPlayTime = 35
  h.setMetadata({ title: 'Song B', artist: 'Artist B', src: '' })
  await replay.recordNewPlay()

  const stored = h.store.get('ytm_local_history')
  assert.equal(stored.length, 3)
  assert.equal(stored[1].id, 'video-a')
  assert.equal(stored[1].duration, 160, '直前の曲の再生時間が失われない')
  assert.equal(stored[2].id, 'video-b')
})
