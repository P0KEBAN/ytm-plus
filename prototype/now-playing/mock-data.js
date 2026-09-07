/**
 * プロトタイプ用のフィクスチャ。**確認用のデータであり、通信も保存もしない。**
 *
 * Phase 6a で ES モジュールへ変更し、形を Adapter の契約
 * （src/js/newui/adapter/types.js）に合わせた。変更点は3つ。
 *
 *  1. palette を ui / background の2系統に分けた。
 *     以前は1階層に平らに持っていて、player.js が全キーを `--art-<key>` へ
 *     そのまま流していた（SPEC.md §1 の但し書き）。
 *  2. 訳文を LyricLine の中から出し、行ID → 訳文の対応表にした。
 *     翻訳の到着で歌詞行の配列を作り直さずに済むようにするため。
 *  3. trackIndex ではなく itemId でキュー項目を指す。videoId とは別に持つ。
 */

/**
 * primary / secondary / shadow は UI 用（抽象ジャケット、リピート1のバッジ）。
 * base / spot0-3 は背景のグラデーション用。spot0 が最前面、spot3 が最背面。
 * original はグラデーション生成サイトのレシピの色そのもの（ジャケットからスポイト）。
 * 本番では実ジャケットから抽出した色がここへ入る（Phase 7）。
 */
export const PALETTES = Object.freeze({
  original: {
    ui: { primary: '#1d968f', secondary: '#819c76', shadow: '#1f3c40' },
    background: { base: '#000f1d', spot0: '#019e9e', spot1: '#2d4b4d', spot2: '#000f1d', spot3: '#aab580' },
  },
  warm: {
    ui: { primary: '#a34b38', secondary: '#d59b70', shadow: '#301c29' },
    background: { base: '#1a0f16', spot0: '#a34b38', spot1: '#6b3a33', spot2: '#301c29', spot3: '#d59b70' },
  },
  neutral: {
    ui: { primary: '#68717a', secondary: '#adb1b3', shadow: '#222932' },
    background: { base: '#171b21', spot0: '#68717a', spot1: '#454d56', spot2: '#222932', spot3: '#adb1b3' },
  },
});

const originalLines = [
  '離ればなれ', '鳥は群れの中の仲間が', '懐かしくなるのか', '高い声で鳴いた',
  '何も言わない', '言わない僕らは静かに', 'それを聴いていたんだ',
];
const originalTranslations = [
  'Far apart', 'A bird, among the flock', 'Perhaps missing its companions',
  'Called out in a high voice', 'Saying nothing',
  'We remain quietly without words', 'Listening to that sound',
];

const nightLines = [
  '街灯がひとつずつ消えていく',
  'この道の先に何があるとしても、たとえ朝焼けが昨日までの景色をすべて変えてしまっても',
  '君と歩いた分だけ覚えている',
  '夜明けまであと少し',
  'まだ眠らない声がする',
];
const nightTranslations = [
  'The streetlights fade one by one',
  'Whatever waits beyond this road, even if the sunrise changes everything we knew until yesterday',
  'I remember the distance we walked',
  'A little longer until dawn',
  'A voice is still awake',
];

/** 行の配列と訳の対応表を、同じ行IDで組み立てる。 */
const buildLyrics = (prefix, texts, translations, timeAt) => {
  const lines = texts.map((text, i) => ({ id: `${prefix}${i}`, at: timeAt(i), text }));
  const translation = {};
  texts.forEach((_, i) => { translation[`${prefix}${i}`] = translations[i]; });
  return { lines, translation };
};

const sakanaction = buildLyrics(
  's', originalLines, originalTranslations,
  // 元モックの初期表示（140秒地点が4行目）に合わせたタイミング。
  i => (i === 0 ? 0 : 140 + (i - 1) * 8),
);
const night = buildLyrics('n', nightLines, nightTranslations, i => i * 10);

/**
 * キューの中身。**配列の順序がそのままキュー順**だが、
 * UI はインデックスではなく itemId で項目を指す。
 */
export const FIXTURES = Object.freeze([
  {
    itemId: 'queue-1', videoId: 'mock-sakanaction',
    title: 'ミュージック', artist: 'サカナクション - sacanaction', album: 'sakanaction',
    artworkUrl: 'assets/artwork.png', palette: PALETTES.original, duration: 240,
    lines: sakanaction.lines, translation: sakanaction.translation, lyricsSource: 'MOCK',
  },
  {
    itemId: 'queue-2', videoId: 'mock-night',
    title: '夜明けまであと少しだけ、この街の音を聴いていたい',
    artist: 'カタバミ・レコーズ / 灯と街のオーケストラ — Live at the long, long night',
    album: 'Night Transit',
    artworkUrl: null, palette: PALETTES.warm, duration: 225,
    lines: night.lines, translation: night.translation, lyricsSource: 'MOCK',
  },
  {
    itemId: 'queue-3', videoId: 'mock-gray',
    title: 'Untitled (Rev. 3)', artist: '葉山 透子', album: 'Grayscale Sessions',
    artworkUrl: null, palette: PALETTES.neutral, duration: 180,
    lines: [], translation: {},
  },
]);
