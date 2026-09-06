/* Local review fixtures only. No network, playback engine, or persistence. */
(() => {
  // primary / secondary / shadow は UI 用（抽象ジャケット、リピート1のバッジなど）。
  // base / spot0-3 は背景のグラデーション用。spot0 が最前面、spot3 が最背面。
  // original はグラデーション生成サイトのレシピの色そのもの（ジャケットからスポイト）。
  // 本番では実ジャケットから抽出した色がここへ入る。
  const palettes = {
    original: { primary: '#1d968f', secondary: '#819c76', shadow: '#1f3c40',
      base: '#000f1d', spot0: '#019e9e', spot1: '#2d4b4d', spot2: '#000f1d', spot3: '#aab580' },
    warm: { primary: '#a34b38', secondary: '#d59b70', shadow: '#301c29',
      base: '#1a0f16', spot0: '#a34b38', spot1: '#6b3a33', spot2: '#301c29', spot3: '#d59b70' },
    neutral: { primary: '#68717a', secondary: '#adb1b3', shadow: '#222932',
      base: '#171b21', spot0: '#68717a', spot1: '#454d56', spot2: '#222932', spot3: '#adb1b3' },
  };
  const originalLines = ['離ればなれ', '鳥は群れの中の仲間が', '懐かしくなるのか', '高い声で鳴いた', '何も言わない', '言わない僕らは静かに', 'それを聴いていたんだ'];
  const translations = ['Far apart', 'A bird, among the flock', 'Perhaps missing its companions', 'Called out in a high voice', 'Saying nothing', 'We remain quietly without words', 'Listening to that sound'];
  const tracks = [
    { id: 'mock-sakanaction', title: 'ミュージック', artist: 'サカナクション - sacanaction', album: 'sakanaction', artwork: 'assets/artwork.png', palette: palettes.original, duration: 240,
      lines: originalLines.map((text, i) => ({ id: `s${i}`, at: i === 0 ? 0 : 140 + (i - 1) * 8, text, translation: translations[i] })) },
    { id: 'mock-night', title: '夜明けまであと少しだけ、この街の音を聴いていたい', artist: 'カタバミ・レコーズ / 灯と街のオーケストラ — Live at the long, long night', album: 'Night Transit', artwork: null, palette: palettes.warm, duration: 225,
      lines: ['街灯がひとつずつ消えていく', 'この道の先に何があるとしても、たとえ朝焼けが昨日までの景色をすべて変えてしまっても', '君と歩いた分だけ覚えている', '夜明けまであと少し', 'まだ眠らない声がする'].map((text, i) => ({ id: `n${i}`, at: i * 10, text, translation: ['The streetlights fade one by one', 'Whatever waits beyond this road, even if the sunrise changes everything we knew until yesterday', 'I remember the distance we walked', 'A little longer until dawn', 'A voice is still awake'][i] })) },
    { id: 'mock-gray', title: 'Untitled (Rev. 3)', artist: '葉山 透子', album: 'Grayscale Sessions', artwork: null, palette: palettes.neutral, duration: 180, lines: [] },
  ];
  window.MockData = Object.freeze({ tracks, palettes });
})();
