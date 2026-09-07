import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const lyricsUiSource = fs.readFileSync(
  new URL('../src/js/module/lyrics-ui.js', import.meta.url),
  'utf8',
)
const contentSource = fs.readFileSync(
  new URL('../src/js/content.js', import.meta.url),
  'utf8',
)
const styleSource = fs.readFileSync(
  new URL('../src/css/style.css', import.meta.url),
  'utf8',
)
const pipManagerSource = fs.readFileSync(
  new URL('../src/js/module/pip-manager.js', import.meta.url),
  'utf8',
)

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker)
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`)
  const end = source.indexOf(endMarker, start)
  assert.notEqual(end, -1, `missing source marker: ${endMarker}`)
  return source.slice(start, end)
}

function extractFunctionDeclaration(source, functionName) {
  const marker = `function ${functionName}`
  const markerStart = source.indexOf(marker)
  assert.notEqual(markerStart, -1, `missing function: ${functionName}`)
  const start = source.slice(Math.max(0, markerStart - 6), markerStart) === 'async '
    ? markerStart - 6
    : markerStart
  const openBrace = source.indexOf('{', start)
  assert.notEqual(openBrace, -1, `missing function body: ${functionName}`)

  let depth = 0
  let state = 'code'
  let escaped = false
  for (let index = openBrace; index < source.length; index += 1) {
    const char = source[index]
    const next = source[index + 1]

    if (state === 'line-comment') {
      if (char === '\n') state = 'code'
      continue
    }
    if (state === 'block-comment') {
      if (char === '*' && next === '/') {
        state = 'code'
        index += 1
      }
      continue
    }
    if (state !== 'code') {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (
        (state === 'single-quote' && char === "'") ||
        (state === 'double-quote' && char === '"') ||
        (state === 'template' && char === '`')
      ) {
        state = 'code'
      }
      continue
    }

    if (char === '/' && next === '/') {
      state = 'line-comment'
      index += 1
      continue
    }
    if (char === '/' && next === '*') {
      state = 'block-comment'
      index += 1
      continue
    }
    if (char === "'") {
      state = 'single-quote'
      continue
    }
    if (char === '"') {
      state = 'double-quote'
      continue
    }
    if (char === '`') {
      state = 'template'
      continue
    }
    if (char === '{') depth += 1
    if (char === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, index + 1)
    }
  }

  assert.fail(`unterminated function: ${functionName}`)
}

function createPayloadHarness(useAnimatedCaptions = true) {
  const helperSource = sourceBetween(
    lyricsUiSource,
    'const hasCharacterSyncedLines',
    'async function applyLateLyricsUpgrade',
  )
  const context = {
    config: { useAnimatedCaptions },
  }
  vm.runInNewContext(
    `${helperSource}\nglobalThis.helpers = { hasCharacterSyncedLines, selectLyricsPayload };`,
    context,
    { filename: 'lyrics-ui-payload-helpers.js' },
  )
  return context.helpers
}

function runFallbackState(payload, config, notify = true) {
  const updateSource = extractFunctionDeclaration(lyricsUiSource, 'updateLyricsSourceState')
  const context = { config, payload, notify }
  vm.runInNewContext(`
    let currentLyricsSource = null;
    let isFallbackLyrics = false;
    let shown = 0;
    let hidden = 0;
    function showFallbackNotice() { shown += 1; }
    function hideFallbackNotice() { hidden += 1; }
    ${updateSource}
    updateLyricsSourceState(payload, notify);
    globalThis.result = { currentLyricsSource, isFallbackLyrics, shown, hidden };
  `, context, { filename: 'lyrics-ui-fallback-state.js' })
  return context.result
}

test('enabled srv3 animation wins over DynamicLRC and line-only display modes', () => {
  const { hasCharacterSyncedLines, selectLyricsPayload } = createPayloadHarness(true)
  const dynamicLines = [{
    start_ms: '1000',
    chars: [{ char: 'あ', startTimeMs: '1050' }],
  }]
  const payload = {
    lyrics: '[00:01.00] line lyrics',
    animated_lyrics: '<timedtext format="3"><body><p t="1000" d="500">animated lyrics</p></body></timedtext>',
    dynamicLines,
  }

  assert.equal(hasCharacterSyncedLines(dynamicLines), true)
  const selected = selectLyricsPayload(payload)
  assert.equal(selected.text, payload.animated_lyrics)
  assert.equal(selected.dynamicLines, null)
  assert.equal(selected.mode, 'animated')
  assert.equal(selected.quality, 4)

  const withoutAnimated = selectLyricsPayload({ ...payload, animated_lyrics: '' })
  assert.equal(withoutAnimated.text, payload.lyrics)
  assert.equal(withoutAnimated.dynamicLines, dynamicLines)
  assert.equal(withoutAnimated.mode, 'dynamic')
  assert.equal(withoutAnimated.quality, 3)

  const animationDisabled = createPayloadHarness(false).selectLyricsPayload(payload)
  assert.equal(animationDisabled.text, payload.lyrics)
  assert.equal(animationDisabled.dynamicLines, dynamicLines)
  assert.equal(animationDisabled.mode, 'dynamic')
  assert.equal(animationDisabled.quality, 3)

  const lineOnly = createPayloadHarness(false).selectLyricsPayload({
    lyrics: payload.lyrics,
    animated_lyrics: payload.animated_lyrics,
  })
  assert.equal(lineOnly.text, payload.lyrics)
  assert.equal(lineOnly.quality, 2)
})

test('a late character-sync event cannot be downgraded by the original line callback', () => {
  const lateUpgradeSource = extractFunctionDeclaration(lyricsUiSource, 'applyLateLyricsUpgrade')
  assert.match(
    lateUpgradeSource,
    /currentLyricsResultPriority\s*===\s*2\s*&&\s*selected\.quality\s*<=\s*currentLyricsQuality/,
  )

  // 開始マーカーにはログ出力ではなくロジック本体を使う。
  // 以前は "console.log('[CS] GET_LYRICS response:', res);" を目印にしていたが、
  // 83df7e4 でログ関数が YTMLog.log へ置き換わった際にこのテストが壊れた。
  // ログの文言や出力手段は今後も変わりうるため、マーカーにしない。
  const responseSource = sourceBetween(
    lyricsUiSource,
    'const preferYtm = preferYtmSource;',
    "console.error('GET_LYRICS failed', e);",
  )
  assert.match(
    responseSource,
    /selectedResponse\.quality\s*<\s*currentLyricsQuality/,
  )
  assert.match(
    responseSource,
    /selectedResponse\.quality\s*===\s*currentLyricsQuality/,
  )
  assert.match(lyricsUiSource, /dataQuality\s*!==\s*currentLyricsQuality/)
})

test('srv3 can replace preferred YTM lyrics both immediately and after the 400ms race', () => {
  const lateUpgradeSource = extractFunctionDeclaration(lyricsUiSource, 'applyLateLyricsUpgrade')
  assert.match(
    lateUpgradeSource,
    /currentLyricsFromPreferredYtm[\s\S]*?selected\.mode\s*!==\s*'animated'/,
  )

  const loadSource = sourceBetween(
    lyricsUiSource,
    'const backgroundPromise = new Promise',
    "console.error('GET_LYRICS failed', e);",
  )
  assert.match(loadSource, /selectLyricsPayload\(late\)\.mode\s*===\s*'animated'/)
  assert.match(loadSource, /applyLateLyricsUpgrade\(late\)/)
  assert.match(loadSource, /backgroundHasSrv3/)
  assert.match(loadSource, /!backgroundHasSrv3/)
})

test('finished DynamicLRC rows become past rows in the main view and PiP', () => {
  const highlightSource = extractFunctionDeclaration(lyricsUiSource, 'updateLyricHighlight')
  assert.match(highlightSource, /primaryHasDynamicRange/)
  assert.match(highlightSource, /primaryIsActive/)
  assert.match(highlightSource, /primaryDynamicEnded/)
  assert.match(highlightSource, /classList\.toggle\('lyric-past', isPast\)/)

  assert.match(pipManagerSource, /#pip-lyrics-container \.lyric-line\.lyric-past/)
  assert.match(pipManagerSource, /ytm-user-browsing-lyrics/)
  assert.match(pipManagerSource, /ytm-keep-past-lyrics/)
})

test('srv3 frames are mirrored to the open PiP stage', () => {
  const renderSource = extractFunctionDeclaration(lyricsUiSource, 'renderAnimatedTimedText')
  const updateSource = extractFunctionDeclaration(lyricsUiSource, 'updateAnimatedCaptionStage')
  assert.match(renderSource, /PipManager\.pipLyricsContainer\.innerHTML\s*=\s*ui\.lyrics\.innerHTML/)
  assert.match(updateSource, /PipManager\.pipLyricsContainer\.querySelector\('\.ytm-animated-caption-stage'\)/)
  assert.match(updateSource, /availableStages\.forEach/)
  assert.match(pipManagerSource, /body\.ytm-animated-caption-mode #pip-lyrics-container/)
})

test('late metadata cannot replace an active srv3 stage with ordinary lyric rows', () => {
  const metaListenerSource = sourceBetween(
    lyricsUiSource,
    "if (msg.type !== 'LYRICS_META_UPDATE') return;",
    '// candidates/config が更新されたらメニューを再描画',
  )
  assert.match(metaListenerSource, /const keepAnimatedStage\s*=\s*!!\(/)
  assert.match(metaListenerSource, /config\.useAnimatedCaptions/)
  assert.match(metaListenerSource, /animatedCaptionData/)
  assert.match(metaListenerSource, /ytm-animated-caption-mode/)
  assert.match(metaListenerSource, /if \(!keepAnimatedStage\)\s*\{[\s\S]*?renderLyrics\(lyricsData\)/)
})

test('character-sync detection accepts supported text and timestamp aliases', () => {
  const { hasCharacterSyncedLines } = createPayloadHarness()
  const aliasPairs = [
    { c: 'A', t: 100 },
    { char: 'B', startTimeMs: '200' },
    { text: 'C', start_ms: 300 },
    { caption: 'D', startMs: 400 },
    { value: 'E', time: 500 },
  ]

  for (const char of aliasPairs) {
    assert.equal(hasCharacterSyncedLines([{ chars: [char] }]), true)
  }
  assert.equal(hasCharacterSyncedLines([{ chars: [{ char: 'missing time' }] }]), false)
  assert.equal(hasCharacterSyncedLines([{ chars: [{ char: 'null time', t: null }] }]), false)
  assert.equal(hasCharacterSyncedLines([{ chars: [{ char: 'empty time', t: '' }] }]), false)
  assert.equal(hasCharacterSyncedLines([{ chars: [{ char: 'blank time', t: '   ' }] }]), false)
  assert.equal(hasCharacterSyncedLines([{ chars: [{ c: '', char: 'alias text', t: '', startTimeMs: 600 }] }]), true)
})

test('dynamic character aliases are normalized to renderer c/t fields', () => {
  const normalizeSource = extractFunctionDeclaration(
    lyricsUiSource,
    'normalizeDynamicLinesToCharLevel',
  )
  const context = {}
  vm.runInNewContext(
    `${normalizeSource}\nglobalThis.normalize = normalizeDynamicLinesToCharLevel;`,
    context,
    { filename: 'lyrics-ui-dynamic-normalizer.js' },
  )

  const normalized = context.normalize([{
    start_ms: '1000',
    chars: [
      { char: 'あ', startTimeMs: '1050' },
      { text: 'い', start_ms: 1125 },
      { caption: 'う', startMs: '1200' },
      { value: 'え', time: 1275 },
    ],
  }])
  const plain = JSON.parse(JSON.stringify(normalized))

  assert.equal(plain[0].startTimeMs, 1000)
  assert.equal(plain[0].text, 'あいうえ')
  assert.deepEqual(
    plain[0].chars.map(({ c, t }) => ({ c, t })),
    [
      { c: 'あ', t: 1050 },
      { c: 'い', t: 1125 },
      { c: 'う', t: 1200 },
      { c: 'え', t: 1275 },
    ],
  )

  const aliasFallback = JSON.parse(JSON.stringify(context.normalize([{
    startTimeMs: '',
    start_ms: 500,
    chars: [{ c: '', char: 'F', t: '', startTimeMs: 600 }],
  }])))
  assert.equal(aliasFallback[0].startTimeMs, 500)
  assert.deepEqual(
    aliasFallback[0].chars.map(({ c, t }) => ({ c, t })),
    [{ c: 'F', t: 600 }],
  )
})

test('dynamic line matching ignores blank primary timestamps and uses valid aliases', () => {
  const helperSource = sourceBetween(
    lyricsUiSource,
    'const toFiniteDynamicTime',
    'const getDynamicLineEndSec',
  )
  const context = {}
  vm.runInNewContext(
    `${helperSource}\nglobalThis.getStart = getDynamicLineStartSec;`,
    context,
    { filename: 'lyrics-ui-dynamic-line-start.js' },
  )

  assert.equal(context.getStart({ startTimeMs: '', start_ms: 1250 }), 1.25)
  assert.equal(context.getStart({ startTimeMs: '   ', chars: [{ t: '', startTimeMs: 1500 }] }), 1.5)
})

test('legacy string cache is provisional while new manual cache remains authoritative', () => {
  const cacheSource = sourceBetween(
    lyricsUiSource,
    "} else if (typeof cached === 'string') {",
    "} else if (typeof cached === 'object') {",
  )
  const legacyBody = cacheSource.slice(cacheSource.indexOf('{') + 1)
  const legacyContext = { cached: '[00:01.00] legacy line' }
  vm.runInNewContext(`
    let data = null;
    let dataPriority = 99;
    let currentLyricsResultPriority = 99;
    ${legacyBody}
    globalThis.result = { data, dataPriority, currentLyricsResultPriority };
  `, legacyContext, { filename: 'lyrics-ui-legacy-cache.js' })

  assert.equal(legacyContext.result.data, legacyContext.cached)
  assert.ok(legacyContext.result.dataPriority < 2)
  assert.ok(legacyContext.result.currentLyricsResultPriority < 2)

  const objectCacheSource = sourceBetween(
    lyricsUiSource,
    "} else if (typeof cached === 'object') {",
    'syncLyricsLockState();',
  )
  assert.match(
    objectCacheSource,
    /currentLyricsResultPriority\s*=\s*cached\.manualLyrics\s*\?\s*3\s*:\s*\(cachedLrcLibIsFallback\s*\?\s*1\s*:\s*2\)/,
  )
})

test('cached LrcLib lyrics are fallback only in standard mode and respect its toggle', () => {
  const objectCacheSource = sourceBetween(
    lyricsUiSource,
    "} else if (typeof cached === 'object') {",
    'syncLyricsLockState();',
  )
  const policyMatch = objectCacheSource.match(
    /const cachedSource\s*=[\s\S]*?const cacheSourceAllowed\s*=\s*[^;]+;/,
  )
  assert.ok(policyMatch, 'cached LrcLib policy should be present')
  const priorityMatch = objectCacheSource.match(
    /currentLyricsResultPriority\s*=\s*cached\.manualLyrics\s*\?\s*3\s*:\s*\(cachedLrcLibIsFallback\s*\?\s*1\s*:\s*2\)\s*;/,
  )
  assert.ok(priorityMatch, 'cache priority policy should be present')

  const evaluate = (cached, config) => {
    const context = { cached, config }
    vm.runInNewContext(`
      ${policyMatch[0]}
      let currentLyricsResultPriority = 0;
      ${priorityMatch[0]}
      globalThis.result = {
        cachedLrcLibIsFallback,
        cacheSourceAllowed,
        priority: currentLyricsResultPriority,
      };
    `, context, { filename: 'lyrics-ui-cache-policy.js' })
    return context.result
  }

  assert.deepEqual(
    { ...evaluate({ lyricsSource: 'lrclib' }, { lyricSourceMode: 'standard', useLrcLibFallback: true }) },
    { cachedLrcLibIsFallback: true, cacheSourceAllowed: true, priority: 1 },
  )
  assert.deepEqual(
    { ...evaluate({ lyricsSource: 'lrclib' }, { lyricSourceMode: 'standard', useLrcLibFallback: false }) },
    { cachedLrcLibIsFallback: true, cacheSourceAllowed: false, priority: 1 },
  )
  assert.deepEqual(
    { ...evaluate({ lyricsSource: 'lrclib' }, { lyricSourceMode: 'lrclib', useLrcLibFallback: false }) },
    { cachedLrcLibIsFallback: false, cacheSourceAllowed: true, priority: 2 },
  )
  assert.equal(
    evaluate({ lyricsSource: 'manual', manualLyrics: true }, { lyricSourceMode: 'standard', useLrcLibFallback: true }).priority,
    3,
  )
})

test('late LRCHub upgrade rejects stale track, request, and video identities', async () => {
  const lateUpgradeSource = extractFunctionDeclaration(lyricsUiSource, 'applyLateLyricsUpgrade')
  const createHarness = () => {
    const context = {}
    vm.runInNewContext(`
      let currentKey = 'Song///Artist';
      let activeLyricsRequestId = 'request-1';
      let currentLyricsVideoId = 'video-1';
      let selectedCandidateId = null;
      let currentLyricsResultPriority = 1;
      let payloadSelections = 0;
      function selectLyricsPayload() {
        payloadSelections += 1;
        return { text: '' };
      }
      ${lateUpgradeSource}
      globalThis.run = applyLateLyricsUpgrade;
      globalThis.selectionCount = () => payloadSelections;
    `, context, { filename: 'lyrics-ui-late-upgrade.js' })
    return context
  }
  const validPayload = {
    success: true,
    lyricsSource: 'lrchub',
    track_key: 'Song///Artist',
    request_id: 'request-1',
    video_id: 'video-1',
  }

  for (const patch of [
    { track_key: 'Other///Artist' },
    { request_id: 'request-old' },
    { video_id: 'video-old' },
  ]) {
    const harness = createHarness()
    await harness.run({ ...validPayload, ...patch })
    assert.equal(harness.selectionCount(), 0)
  }

  const currentHarness = createHarness()
  await currentHarness.run(validPayload)
  assert.equal(currentHarness.selectionCount(), 1)
})

test('normalized timed translations win over raw translation payloads in the UI', () => {
  const lateUpgradeSource = extractFunctionDeclaration(lyricsUiSource, 'applyLateLyricsUpgrade')
  const rawIndex = lateUpgradeSource.indexOf('normalizeTranslationsToLrcMapLocal(payload.translations)')
  const normalizedIndex = lateUpgradeSource.indexOf('normalizeTranslationsToLrcMapLocal(payload.lrcMap)')

  assert.ok(rawIndex >= 0)
  assert.ok(normalizedIndex > rawIndex)
  assert.match(
    lyricsUiSource,
    /normalizeTranslationsToLrcMapLocal\(res\?\.translations\)[\s\S]{0,160}normalizeTranslationsToLrcMapLocal\(res\?\.lrcMap\)/,
  )
})

test('same-title video changes and candidate awaits carry explicit identity guards', () => {
  const tickGuard = /currentKey\s*!==\s*key\s*\|\|\s*\(currentLyricsVideoId\s*\|\|\s*''\)\s*!==\s*videoId/
  assert.match(lyricsUiSource, tickGuard)

  const candidateSource = extractFunctionDeclaration(lyricsUiSource, 'ensureCandidateLyricsLoaded')
  assert.match(candidateSource, /const candidateKeyAtStart\s*=\s*currentKey/)
  assert.match(candidateSource, /const candidateVideoAtStart\s*=\s*currentLyricsVideoId\s*\|\|\s*getCurrentVideoId\(\)\s*\|\|\s*''/)
  assert.match(
    candidateSource,
    /currentKey\s*!==\s*candidateKeyAtStart[\s\S]*?currentLyricsVideoId[\s\S]*?!==\s*candidateVideoAtStart[\s\S]*?lyricsCandidates\s*!==\s*candidateListAtStart/,
  )
  assert.match(candidateSource, /candidateNeedsFullRecord/)
  assert.match(candidateSource, /cand\?\.lyricsComplete\s*!==\s*true/)
})

test('fallback notice appears only for enabled standard-mode LrcLib fallback', () => {
  const standardConfig = { lyricSourceMode: 'standard', useLrcLibFallback: true }
  const shown = runFallbackState(
    { lyricsSource: 'lrclib', fallbackUsed: true },
    standardConfig,
  )
  assert.deepEqual(
    { ...shown },
    { currentLyricsSource: 'lrclib', isFallbackLyrics: true, shown: 1, hidden: 0 },
  )

  const disabled = runFallbackState(
    { lyricsSource: 'lrclib', fallbackUsed: true },
    { lyricSourceMode: 'standard', useLrcLibFallback: false },
  )
  assert.equal(disabled.shown, 0)
  assert.equal(disabled.isFallbackLyrics, false)

  const lrcLibOnly = runFallbackState(
    { lyricsSource: 'lrclib', fallbackUsed: true },
    { lyricSourceMode: 'lrclib', useLrcLibFallback: true },
  )
  assert.equal(lrcLibOnly.shown, 0)
  assert.equal(lrcLibOnly.isFallbackLyrics, false)

  const upgraded = runFallbackState(
    { lyricsSource: 'lrchub', fallbackUsed: false },
    standardConfig,
    false,
  )
  assert.equal(upgraded.shown, 0)
  assert.equal(upgraded.hidden, 1)
})

test('fallback notice has dedicated quiet CSS away from the generic toast', () => {
  const fallbackBlock = sourceBetween(
    styleSource,
    '#ytm-fallback-toast {',
    '#ytm-fallback-toast.visible',
  )
  assert.match(fallbackBlock, /position:\s*fixed/)
  assert.match(fallbackBlock, /bottom:\s*calc\(/)
  assert.match(fallbackBlock, /right:\s*18px/)
  assert.match(fallbackBlock, /font-size:\s*11px/)
  assert.match(fallbackBlock, /pointer-events:\s*none/)
  assert.match(fallbackBlock, /opacity:\s*0/)
  assert.doesNotMatch(fallbackBlock, /\btop\s*:/)
  assert.doesNotMatch(styleSource, /#ytm-toast\s*,\s*#ytm-fallback-toast/)
  assert.match(styleSource, /#ytm-fallback-toast\.visible\s*\{[\s\S]*?opacity:\s*1/)
  assert.match(lyricsUiSource, /createEl\('div',\s*'ytm-fallback-toast'/)
})

test('cold start waits for persisted lyric settings before observation and playback loops', () => {
  const settingsSource = sourceBetween(
    lyricsUiSource,
    'const runtimeSettingsReady',
    '// ===================== 初期化',
  )
  for (const key of [
    'ytm_sync_offset',
    'ytm_save_sync_offset',
    'ytm_lrclib_fallback',
    'ytm_lyric_source_mode',
    'ytm_animated_captions_enabled',
  ]) {
    assert.match(settingsSource, new RegExp(`storage\\.get\\('${key}'\\)`))
  }
  assert.match(
    contentSource,
    /Promise\.resolve\(runtimeSettingsReady\)\.then\(\(\)\s*=>\s*\{[\s\S]*?setupObserver\(\)[\s\S]*?startLyricRafLoop\(\)/,
  )
})
