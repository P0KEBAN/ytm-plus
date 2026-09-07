import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const lyricsUiSource = fs.readFileSync(
  new URL('../src/js/module/lyrics-ui.js', import.meta.url),
  'utf8',
)

const functionStart = lyricsUiSource.indexOf('function updateLyricHighlight(currentTime)')
const functionEnd = lyricsUiSource.indexOf('async function sendLockRequest', functionStart)
assert.notEqual(functionStart, -1, 'updateLyricHighlight should be present')
assert.notEqual(functionEnd, -1, 'updateLyricHighlight end marker should be present')
const updateSource = lyricsUiSource.slice(functionStart, functionEnd)

class FakeClassList {
  constructor(...names) {
    this.names = new Set(names)
  }

  add(...names) {
    names.forEach(name => this.names.add(name))
  }

  remove(...names) {
    names.forEach(name => this.names.delete(name))
  }

  contains(name) {
    return this.names.has(name)
  }

  toggle(name, force) {
    const enabled = force === undefined ? !this.names.has(name) : !!force
    if (enabled) this.names.add(name)
    else this.names.delete(name)
    return enabled
  }
}

function makeRow() {
  return {
    classList: new FakeClassList('lyric-line'),
    dataset: {},
    querySelectorAll() { return [] },
  }
}

function createHighlightHarness(lyricsData, hasDynamicRanges) {
  const rows = lyricsData.map(() => makeRow())
  const container = {
    children: rows,
    _lastScrolledIndex: -1,
  }
  const context = {
    DYNAMIC_OVERLAP_TOLERANCE: 0.05,
    DUET_DUPLICATE_TOLERANCE: 1,
    PipManager: { pipWindow: null, pipLyricsContainer: null },
    ReplayManager: { incrementLyricCount() {} },
    dynamicLines: hasDynamicRanges ? [{}] : null,
    lyricsData,
    rows,
    ui: { lyrics: container },
    hasTimestamp: true,
    isUserScrolling: false,
    meaningPanelVisible: false,
    isLineDynamicallyActiveAtTime(line, time, tolerance = 0.05) {
      return Number.isFinite(line?._dynamicRenderStartSec) &&
        Number.isFinite(line?._dynamicRenderEndSec) &&
        time + tolerance >= line._dynamicRenderStartSec &&
        time <= line._dynamicRenderEndSec + tolerance
    },
    isSameTimestamp(a, b, tolerance = 0.05) {
      return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tolerance
    },
    normalizeLyricCompareTextStrict(value) {
      return String(value || '').replace(/\s+/g, '').toLowerCase()
    },
    scoreLyricTextMatch(a, b) { return a === b ? 100 : 0 },
    syncMeaningPanelToPlayback() {},
    clearTimeout() {},
    setTimeout() { return 1 },
  }

  vm.runInNewContext(`
    let lastActiveIndex = -1;
    let _hasDynamicRenderRanges = ${hasDynamicRanges ? 'true' : 'false'};
    let _previousActiveIndices = new Set();
    let _activeRowsHaveCharSpans = false;
    let isProgrammaticScrolling = false;
    let programmaticScrollTimeout = null;
    let programmaticScrollMaxTimeout = null;
    ${updateSource}
    globalThis.runAt = (time, expectedPrimaryIndex) => {
      ui.lyrics._lastScrolledIndex = expectedPrimaryIndex;
      updateLyricHighlight(time);
      return rows.map(row => ({
        active: row.classList.contains('active'),
        past: row.classList.contains('lyric-past'),
      }));
    };
  `, context, { filename: 'lyrics-highlight-state.js' })

  return {
    runAt(...args) {
      return JSON.parse(JSON.stringify(context.runAt(...args)))
    },
  }
}

test('DynamicLRC rows fade after their own end and recover after a backward seek', () => {
  const harness = createHighlightHarness([
    { time: 1, text: 'First', _dynamicRenderStartSec: 1, _dynamicRenderEndSec: 2 },
    { time: 8, text: 'Second', _dynamicRenderStartSec: 8, _dynamicRenderEndSec: 9 },
  ], true)

  assert.deepEqual(harness.runAt(1.5, 0), [
    { active: true, past: false },
    { active: false, past: false },
  ])
  assert.deepEqual(harness.runAt(3, 0), [
    { active: false, past: true },
    { active: false, past: false },
  ])
  assert.deepEqual(harness.runAt(8.5, 1), [
    { active: false, past: true },
    { active: true, past: false },
  ])
  assert.deepEqual(harness.runAt(10, 1), [
    { active: false, past: true },
    { active: false, past: true },
  ])
  assert.deepEqual(harness.runAt(1.5, 0), [
    { active: true, past: false },
    { active: false, past: false },
  ])
})

test('regular LRC keeps the current row active until the next timestamp', () => {
  const harness = createHighlightHarness([
    { time: 1, text: 'First' },
    { time: 8, text: 'Second' },
  ], false)

  assert.deepEqual(harness.runAt(3, 0), [
    { active: true, past: false },
    { active: false, past: false },
  ])
  assert.deepEqual(harness.runAt(8.5, 1), [
    { active: false, past: true },
    { active: true, past: false },
  ])
})
