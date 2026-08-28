// 翻訳行の対応付け（buildAlignedTranslations）を検証する。
//
// 共有翻訳APIから返る訳文はタイムスタンプを持たないことがあり、その場合は
// 「n番目の非空 base 行 ↔ n番目の非空 翻訳行」で順に詰める経路を通る。
// この経路は、片側にしか存在しない行が1つでも混ざると以降が全てずれる。
//
// 実際に YouTube Music の歌詞は先頭に演奏マーカー行「♪」を持つことがあり、
// 訳文側にはそれが無いため、訳文を1つ食い潰して曲全体が1行ずれていた
// （ROADMAP 4.13）。ここでは実機で採取した歌詞の並びをそのまま使う。
//
// このテストはソーステキスト検査ではなく実際に関数を動かしている。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const source = fs.readFileSync(
  new URL('../src/js/module/lyrics-ui.js', import.meta.url),
  'utf8',
)

// lyrics-ui.js は content script として1つの巨大スコープに展開される作りで、
// import できない。対応付けに必要な宣言はひと続きに並べてあるので、その区間を
// まとめて切り出して vm 上で評価する。
const REGION_START = 'const isMusicMarkerLine ='
const REGION_END = 'const buildAlignedTranslations ='

const regionStart = source.indexOf(REGION_START)
assert.notEqual(regionStart, -1, `${REGION_START} が見つからない`)
const regionEnd = source.indexOf('\n};', source.indexOf(REGION_END))
assert.notEqual(regionEnd, -1, `${REGION_END} の終端が見つからない`)

const context = vm.createContext({})
vm.runInContext(
  source.slice(regionStart, regionEnd + 3) +
    '\nglobalThis.buildAlignedTranslations = buildAlignedTranslations;',
  context,
)

const buildAlignedTranslations = context.buildAlignedTranslations

const timed = (time, text) => ({ time, text })
const untimed = (text) => ({ time: null, text })
// vm 内で生成された配列はプロトタイプが別realmのものになるため、
// deepStrictEqual が使えるようホスト側の配列へ写す。
const align = (baseLines, transLines, sourceLines) =>
  Array.from(buildAlignedTranslations(baseLines, { ja: transLines }, sourceLines).ja)

test('先頭の演奏マーカー行が訳文を食い潰して全体が1行ずれない', () => {
  // 実機採取。base は YTM 由来でタイムスタンプ付き、先頭が「♪」。
  // 訳文は共有翻訳API由来でタイムスタンプが無く、空行を段落区切りに使っている。
  const base = [
    timed(0, '♪'),
    timed(6.91, 'This night is cold in the kingdom'),
    timed(10.09, 'I can feel you fade away'),
    timed(13.28, 'From the kitchen to the sink'),
    timed(16.51, 'Your steps keep me awake'),
    timed(18.87, "Don't cut me down, throw me out"),
  ]
  const translation = [
    untimed('王国の夜は寒いです'),
    untimed('あなたが消えていくのを感じる'),
    untimed('キッチンから洗面台まで、'),
    untimed('あなたの歩みが私を眠らせない'),
    untimed(''),
    untimed('私を切り捨てたり、放り出したり、私をここに置き去りにしたり'),
  ]

  const result = align(base, translation)

  assert.equal(result[0], '', '「♪」には訳文を割り当てない')
  assert.equal(result[1], '王国の夜は寒いです')
  assert.equal(result[2], 'あなたが消えていくのを感じる')
  assert.equal(result[3], 'キッチンから洗面台まで、')
  assert.equal(result[4], 'あなたの歩みが私を眠らせない')
  assert.equal(result[5], '私を切り捨てたり、放り出したり、私をここに置き去りにしたり')
})

test('演奏マーカーが訳文側にだけある場合も逆方向にずれない', () => {
  const result = align(
    [untimed('AAA'), untimed('BBB')],
    [untimed('♪'), untimed('あああ'), untimed('いいい')],
  )

  assert.deepEqual(result, ['あああ', 'いいい'])
})

test('演奏マーカーが両側にある場合も対応付けが保たれる', () => {
  const result = align(
    [untimed('♪'), untimed('AAA')],
    [untimed('♪'), untimed('あああ')],
  )

  assert.deepEqual(result, ['', 'あああ'])
})

test('訳文が尽きた行は null になり原文へフォールバックできる', () => {
  // '' を返すと getLangTextAt が有効値として扱うため、主表示言語が翻訳のとき
  // 歌詞本文そのものが空になる。null なら呼び出し側が原文へ戻せる。
  const result = align(
    [untimed('AAA'), untimed('BBB'), untimed('CCC')],
    [untimed('あああ')],
  )

  assert.equal(result[0], 'あああ')
  assert.equal(result[1], null)
  assert.equal(result[2], null)
})

test('段落区切りの空行は対応付けを進めない', () => {
  const result = align(
    [untimed('AAA'), untimed(''), untimed('BBB')],
    [untimed('あああ'), untimed(''), untimed('いいい')],
  )

  assert.deepEqual(result, ['あああ', '', 'いいい'])
})

test('タイムスタンプ付きの訳文は時刻で突き合わせる経路のまま変わらない', () => {
  const result = align(
    [timed(1, '♪'), timed(2, 'AAA'), timed(3, 'BBB')],
    [timed(2, 'あああ'), timed(3, 'いいい')],
  )

  // 「♪」は一致する訳文が無いので null のまま（原文へフォールバック）。
  assert.deepEqual(result, [null, 'あああ', 'いいい'])
})

test('翻訳元が別バージョンでも、余分な行を飛ばして対応付けられる', () => {
  // 実機で観測した崩れ方の再現。翻訳元の歌詞にはサビ末尾の
  // "Let me down, down, let me down" が3行あるが、表示中の歌詞には2行しかない。
  // 位置で詰めるだけだと、ここから曲の最後まで1行ずつずれ続ける。
  const base = [
    timed(0, '♪'),
    timed(10, 'Let me down, down, let me down'),
    timed(20, 'Let me down, down, let me down'),
    timed(30, "If you wanna go then I'll be so lonely"),
    timed(40, "If you're leavin', baby, let me down slow"),
  ]
  const source = [
    untimed('Let me down, down, let me down'),
    untimed('Let me down, down, let me down'),
    untimed('Let me down, down, let me down'),
    untimed("If you wanna go then I'll be so lonely"),
    untimed("If you're leavin', baby, let me down slow"),
  ]
  const translation = [
    untimed('ダウンさせて、ダウンさせて、ダウンさせて、ダウンさせて'),
    untimed('ダウンさせて、ダウンさせて、ダウンさせて'),
    untimed('私を失望させて、降下させて、私を失望させてください'),
    untimed('あなたが行きたいなら、とても寂しいです'),
    untimed('あなたが去るなら、ベイビー、ゆっくりと私を降ろしてください'),
  ]

  const result = align(base, translation, source)

  assert.equal(result[0], '', '「♪」には訳文を割り当てない')
  // 余った翻訳元の1行は捨てられ、以降の行が正しい訳文に戻る。
  assert.equal(result[3], 'あなたが行きたいなら、とても寂しいです')
  assert.equal(result[4], 'あなたが去るなら、ベイビー、ゆっくりと私を降ろしてください')
})

test('表示中の歌詞にしかない行は訳文を持たず、後続をずらさない', () => {
  const base = [
    untimed('AAA'),
    untimed('ONLY IN BASE'),
    untimed('BBB'),
  ]
  const source = [untimed('AAA'), untimed('BBB')]
  const translation = [untimed('あああ'), untimed('いいい')]

  const result = align(base, translation, source)

  assert.equal(result[0], 'あああ')
  assert.equal(result[2], 'いいい', 'base 固有の行が後続をずらしてはいけない')
})

test('語句が違う行どうしは同じ位置の言い換えとして結ぶ', () => {
  // 表示中の歌詞と翻訳元で言い回しが違うことがある（実機では
  // "to the bathroom" と "to the sink"）。前後が一致していれば
  // その1行は同じ行の言い換えとみなす。
  const base = [
    untimed('This night is cold'),
    untimed('From the kitchen to the bathroom'),
    untimed('Your steps keep me awake'),
  ]
  const source = [
    untimed('This night is cold'),
    untimed('From the kitchen to the sink'),
    untimed('Your steps keep me awake'),
  ]
  const translation = [
    untimed('この夜は寒い'),
    untimed('キッチンから洗面台まで'),
    untimed('あなたの歩みが私を眠らせない'),
  ]

  assert.deepEqual(align(base, translation, source), [
    'この夜は寒い',
    'キッチンから洗面台まで',
    'あなたの歩みが私を眠らせない',
  ])
})

test('翻訳元と訳文の行数が食い違うときは翻訳元を使わない', () => {
  // 翻訳元と訳文が1対1でないなら対応表は信用できない。
  // 誤った対応を作るより、従来どおり順に詰める挙動へ戻す。
  const base = [untimed('AAA'), untimed('BBB')]
  const source = [untimed('AAA'), untimed('BBB'), untimed('CCC')]
  const translation = [untimed('あああ'), untimed('いいい')]

  assert.deepEqual(align(base, translation, source), ['あああ', 'いいい'])
})
