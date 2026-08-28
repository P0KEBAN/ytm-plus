# YouTube Music 内部構造の実測メモ

最終更新: 2026-08-29 / 測定環境: macOS + Chrome **152.0.0.0** / YTM 日本語UI

このファイルは **YouTube Music 側の内部構造について実機で測った事実**を置く場所である。
開発計画（`private-docs/ROADMAP.md`。このリポジトリには含まれない）が「何をやるか」を持ち、
このファイルが「YTM は実際どうなっているか」を持つ。

**ここに書いてあることは全て実機で確認した値である。** 推測は「推測」と明記してある。
YTM は予告なく変わるので、**壊れたら §1 の手順で測り直し、このファイルを更新すること。**

---

## 1. 壊れたときにまず見るところ

新UIが YTM に依存しているのは以下だけである。YTM 側の変更で壊れたら、まずここを疑う。

### 1.1 MAIN world から触る内部名（7つ）

```text
ytmusic-player-bar . volume            // getter, 0-100（スライダー表示のスケール）
                   . isMuted           // getter, boolean
                   . repeatMode        // getter, "NONE" | "ALL" | "ONE"
                   . shuffleEnabled    // getter, boolean
                   . playing           // getter, boolean
                   . updateVolume(v)   // method, 0-100
                   . queue.store.getState()
```

これらは Closure コンパイラで名前が潰されていない（`JSC$14097_*` のような
リネーム済みの名前と混在している）。Polymer のテンプレートから参照される
プロパティは潰されないためと**推測**される。逆に言えば YTM が実装を変えれば消える。

### 1.2 DOM セレクタ

```text
ytmusic-player-bar .previous-button
ytmusic-player-bar .next-button
ytmusic-player-bar .play-pause-button     （#play-pause-button も実在）
ytmusic-player-bar .shuffle
ytmusic-player-bar .repeat
ytmusic-player-bar .volume
ytmusic-player-bar #volume-slider          （tp-yt-paper-slider）
ytmusic-player-queue-item
video
#movie_player
ytmusic-app
```

### 1.3 再測定の手順

Phase 4 で使った検証プローブは git 履歴に残してある。取り出して使える。

```bash
git show a63681a:src/js/probe/probe-isolated.js   > src/js/probe/probe-isolated.js   # 4a向け初版
git show 65df3d1:src/js/probe/probe-main.js       > src/js/probe/probe-main.js       # 最終版（4b書き込み実測入り）
git show 65df3d1:src/js/probe/probe-isolated.js   > src/js/probe/probe-isolated.js
git show a63681a:src/js/probe/probe-isolated-2.js > src/js/probe/probe-isolated-2.js
git show a63681a:src/js/probe/probe-module.js     > src/js/probe/probe-module.js
git show a63681a:src/js/probe/probe-module-b.js   > src/js/probe/probe-module-b.js
git show a63681a:manifest.json                     # manifest への足し方はこれを見る
```

**測り終わったら必ず消すこと。** プローブは音量とリピートを書き換えるため、
残すとページを開くたびに設定が変わる。削除後は

```bash
diff <(git show 3d7e703:manifest.json) manifest.json
```

で manifest が元に戻っていることを確認する。

---

## 2. content script のスコープ（自分側の制約）

### 2.1 束縛は 325 個。1つのスコープを共有している

manifest の content script 8本は**独立モジュールではなく、1つの isolated world を共有する**。
別の `content_scripts` エントリに分けても同じスコープになる（実機で 9/9 到達を確認）。

トップレベル束縛の**正確な数**と内訳:

| ファイル | 追加する束縛 |
| --- | --- |
| `namespace.js` | 9 |
| `cloud-sync.js` | 54 |
| `replay-manager.js` | 1（`ReplayManager`）|
| `queue-manager.js` | 1（`QueueManager`）|
| `pip-manager.js` | 1（`PipManager`）|
| `ytm-lyrics.js` | **0** |
| `lyrics-ui.js` | **259** |
| `content.js` | 0 |
| **合計** | **325** |

**`ytm-lyrics.js` が 0 なのは、ファイル全体が `(() => { ... })();` で包まれているから。**
7本のうちこの1本だけが正しく閉じている。新しくファイルを足すときの手本になる。

`content.js` も 0 だが、こちらは理由が逆で、**自前の宣言をひとつも持たず**
`lyrics-ui.js` の `setupObserver` / `startLyricRafLoop` / `hoverTimeInfoSetup` /
`runtimeSettingsReady` をそのまま呼んでいる。
つまり**スコープ共有は副作用ではなく、現行コードが依存している前提**である。

### 2.2 新UIが素直に使いそうな名前は既に埋まっている

| 名前 | 定義元 |
| --- | --- |
| `config` | `namespace.js:188` |
| `ui` | `cloud-sync.js:444`（全UI要素のレジストリ）|
| `storage` | `cloud-sync.js:506`（chrome.storage ラッパ）|
| `createEl` | `lyrics-ui.js:1839` |
| `timeOffset` | `cloud-sync.js:431` |
| `lyricsData` | `cloud-sync.js:411` |

衝突すると `SyntaxError: Identifier 'X' has already been declared` で
**拡張全体が起動しなくなる**。`var` / `function` 由来の束縛でも、後から `const` で
再宣言すれば同じく SyntaxError になる（上の 325 個はこれも含めて数えてある）。

### 2.3 数え方（再現手順）

```bash
cat src/js/module/namespace.js src/js/module/cloud-sync.js \
    src/js/module/replay-manager.js src/js/module/queue-manager.js \
    src/js/module/pip-manager.js src/js/module/ytm-lyrics.js \
    src/js/module/lyrics-ui.js src/js/content.js > /tmp/concat.js
```

`/tmp/concat.js` を `vm.Script` でコンパイルし、候補の識別子ごとに `let X;` を末尾に足して
`has already been declared` になるかを見る。正規表現でソースを数える方法は
インデントが混在しているため当てにならない（実際に第2版の「236個」はこれで外していた）。

---

## 3. 新UIの読み込み方式（実測 2026-08-29）

### 3.1 `content_scripts` に ES モジュールの宣言的サポートは無い

Chrome の `content_scripts` エントリが受け付けるキーは
`matches` / `exclude_matches` / `include_globs` / `exclude_globs` / `all_frames` /
`match_origin_as_fallback` / `match_about_blank` / `run_at` / `world` のみ。
**`"type": "module"` は存在しない。** `world` の値も `ISOLATED` / `MAIN` の2つだけ。

出典: https://developer.chrome.com/docs/extensions/reference/manifest/content-scripts

### 3.2 動的 `import()` は music.youtube.com 上で通る

classic な content script から `import(chrome.runtime.getURL('...'))` を呼ぶ方式を実測した。

| 項目 | 結果 |
| --- | --- |
| 読み込み | **成功・3ms** |
| モジュールスコープの独立性 | モジュール内で `const config` を宣言してもグローバルの `config` は無傷 |
| `chrome.runtime.id` | 取得できる |
| `chrome.storage.local.get` | 使える |
| 相対 `import('./other.js')` | 解決できる |
| `document` | 到達できる |
| `import.meta.url` | `chrome-extension://<id>/src/js/probe/probe-module.js` |

**独立スコープと引き換えに拡張の特権を失うトレードオフは発生しない。**
モジュールファイルは `web_accessible_resources` に載せる必要がある。

### 3.3 採用した構成

```text
manifest content_scripts[0].js
  ... 既存7本 ..., content.js, src/js/newui/loader.js   ← 末尾に1本だけ足す
        ↓ import(chrome.runtime.getURL('src/js/newui/main.js'))
  src/js/newui/**.js   … 完全に独立したモジュールスコープ
```

- **`loader.js` は既存エントリの js 配列の末尾に置く。** 別エントリにすると
  エントリ間の実行順が保証されない（Phase 4 のプローブは別エントリで動いたが、
  それはたまたま期待どおりの順序だっただけの可能性がある）
- **`loader.js` はトップレベル宣言ゼロの IIFE にする**（`ytm-lyrics.js` と同じ形）
- **`loader.js` が新旧の唯一の継ぎ目。** 共有スコープの `config` / `storage` /
  `runtimeSettingsReady` などを読めるのは loader だけなので、必要なものを
  `boot({...})` の引数として明示的に渡す。新UI側は共有スコープを一切参照しない
- `content.js` と同様に `runtimeSettingsReady` の解決を待ってから boot する

---

## 4. `ytmusic-player-bar` の API（MAIN world からのみ）

**isolated world からは Polymer のプロパティが一切見えない。**
`ytmusic-player-bar` から拾えるのは `oncontextrestored` / `onvolumechange` という
標準DOM由来の2つだけだった。したがって以下は全て `world: "MAIN"` の
content script からしか触れない。

### 4.1 状態（getter）

| 名前 | 型 | 実測値の例 |
| --- | --- | --- |
| `volume` | number 0-100 | 13 / 20 / 31 / 42 |
| `volumeStep` | number | 1 |
| `isMuted` | boolean | |
| `repeatMode` | string | `"NONE"` → `"ALL"` → `"ONE"` → `"NONE"` |
| `shuffleEnabled` | boolean | |
| `shuffleOn` | boolean | `shuffleEnabled` と常に同じ値だった |
| `playing` | boolean | |
| `isShuffleDisabled` | boolean | false |
| `isLoopDisabled` | boolean | false |
| `playerApi` | object | |
| `queue` | object | §6 参照 |

その他 `seekableStartSeconds` / `seekableEndSeconds` / `seekToSeconds` /
`playerPageOpen` / `playerFullscreened` / `playerInactive` /
`isPlayingPodcastContent` / `playbackRateEnabled` / `displayedMetadata` などもある。

### 4.2 操作（method）

`onPlayPauseButtonClick` / `onPreviousButtonClick` / `onNextButtonClick` /
`onSeekBackButtonClick` / `onSeekForwardButtonClick` / `onShuffleButtonClick` /
`onRepeatButtonClick` / `onUserSeek` / `onVolumeChange` / `onImmediateVolumeChange` /
`updateVolume` / `setContentPlaybackRate` / `gatedSeekBy`

**`onRepeatButtonClick()` は引数なしで呼べて `repeatMode` が正しく進む**ことを実測した
（`NONE` → `ALL`）。同じことは可視な `.repeat` の DOM クリックでもできる（`ALL` → `ONE` → `NONE`）。

### 4.3 `playing` と `video.paused` は意味が違う

バッファリング中に以下の食い違いを観測した。

| ソース | 値 |
| --- | --- |
| `bar.playing` | `false` |
| `#movie_player.getPlayerState()` | `3`（buffering）|
| `video.paused` | **`false`** |

**`video.paused` は「ユーザーが止めたか」、`bar.playing` は「再生ボタンの見た目」に近い。**
ローディング表示を設計するときはこの差を使える。

---

## 5. 音量には3つのスケールがある

### 5.1 読み取り

| ソース | スケール | 実測値 |
| --- | --- | --- |
| `bar.volume` | 0-100（**表示用**）| 13 / 20 / 31 / 42 |
| `#movie_player.getVolume()` | 0-100（実音量）| 2 / 5 / 9 / 15 |
| `<video>.volume` | 0-1（実音量）| 0.02 / 0.05 / 0.09 / 0.15 |

`<video>.volume === #movie_player.getVolume() / 100` は常に一致した。
`bar.volume` はこれらと**非線形に対応する**。YTM が知覚スケールへ変換していると**推測**される。
対応の実測値は `13→2` / `20→5` / `31→9` / `42→15`。

### 5.2 書き込み（3経路を実測）

初期状態 `bar.volume=20` / `mp.getVolume()=5` / `video.volume=0.05` から:

| 経路 | `bar.volume` | `#volume-slider` | `mp.getVolume()` | `video.volume` |
| --- | --- | --- | --- | --- |
| `mp.setVolume(42)` | **20 のまま** | **20 のまま** | 42 | 0.42 |
| `video.volume = 0.42` | **20 のまま** | **20 のまま** | **5 のまま** | 0.42 |
| `bar.updateVolume(42)` | **42** | **42** | 15 | 0.15 |

**`bar.updateVolume(0-100)` だけが、YTM のスライダー表示と実音量の両方を整合させる。**
他の2経路は実音量だけを変えるので、YTM のスライダーが嘘をつく状態になる。

`video.volume` を直接書くと `#movie_player` の内部値（5のまま）とすら乖離する点に注意。

**新UIの音量スライダーは読み書きとも `bar.volume` のスケール（0-100）で統一すればよく、
変換式を知る必要はない。**

---

## 6. キューの正本は `bar.queue.store`

`ytmusic-app.store` は**存在しなかった**（`app.store` / `app._store` / `app.$.store` すべて空振り）。
一方 `ytmusic-player-bar.queue.store.getState()` は取れた。Redux 形式。

`getState()` のトップレベルキー:

```text
castStatus, entities, download, likeStatus, multiSelect, navigation,
player, playerPage, queue, subscribeStatus, toggleStates, ui, uploads,
radioButtonGroup, collabInviteLink, continuation, home
```

`getState().queue` のキー:

```text
automixItems, autoplay, hasShownAutoplay, hasUserChangedDefaultAutoplayMode,
header, impressedVideoIds, isFetchingChipSteer, isGenerating, isInfinite,
isRaarEnabled, isRaarSkip, items, nextQueueItemId, playbackContentMode,
queueContextParams, repeatMode, responsiveSignals, selectedItemIndex,
shuffleEnabled, shuffleEndpoints, steeringChips, watchNextType
```

実測値: `repeatMode: "NONE"` / `shuffleEnabled: false` / `selectedItemIndex: 0` /
`items.length: 50`。各要素は `{ playlistPanelVideoRenderer: {...} }`。

**現行の `queue-manager.js` は `ytmusic-player-queue-item` を DOM 走査しているが、
こちらのほうが正確。** リピート・シャッフルの状態もここから読めるので、
`bar` の getter と合わせて二重に持つ必要はない。

**未確認**: Redux ストアなので `store.subscribe()` が使えればポーリングを購読へ
置き換えられる可能性が高いが、**まだ確認していない**。Phase 6 の実装時に確認し、
駄目ならポーリングのままにする。

---

## 7. プレイヤーバーの DOM 構造

### 7.1 シャッフル / リピート / 音量ボタンは2個ずつ存在する

通常版と展開プレイヤーバー用の2組がある。**非表示のほうを掴むと操作が効かない。**

| 用途 | 通常版（可視）| 展開版（`offsetParent === null`）|
| --- | --- | --- |
| リピート | `.repeat`（1個目）| `#expand-repeat`（`.repeat` クラスも持つ）|
| シャッフル | `.shuffle` | `.expand-shuffle` |
| 音量 | `.volume` | `.expand-volume` |

**可視なほうの選び方（実測で確認済み）:**

```js
Array.from(document.querySelectorAll(sel)).find((el) => el.offsetParent)
```

### 7.2 状態を DOM から読むことはできない

| 手掛かり | リピート | シャッフル |
| --- | --- | --- |
| `aria-label` | 「リピートオフ」「全曲をリピート」「1 曲リピート」→ **ローカライズされる** | **ON/OFF とも「シャッフル」のまま。区別不能** |
| `aria-pressed` | `null` | `null` |
| `yt-icon` の `icon` 属性 | **`null`**（SVG が直接埋め込まれ、属性が存在しない）| `null` |
| クラスの変化 | 観測されず | 観測されず |

**DOM 側に言語非依存の手掛かりがひとつもない。**
SVG の `path` の `d` を照合するくらいしか手が無く、それは論外。
**シャッフル / リピートの状態は MAIN world 経由でしか読めない**というのが実測の結論。

なお**操作**のほうは DOM クリックで問題なく通る（§4.2）。

### 7.3 ボタンの構造

```html
<yt-icon-button class="repeat style-scope ytmusic-player-bar" title="リピートオフ" label="リピートオフ">
  <button id="button" class="style-scope yt-icon-button" aria-label="リピートオフ">
    <yt-icon class="style-scope ytmusic-player-bar">
      <span class="yt-icon-shape ...">
        <svg …><path d="…"/></svg>   ← icon 属性は無く SVG が直接入る
```

クリック対象は内側の `<button>`。`yt-icon-button` 自体をクリックしても通る場合があるが、
既存コードは `el.querySelector('button') || el.querySelector('tp-yt-paper-icon-button') || el`
の順で降りている。この順序は実測でも妥当だった。

### 7.4 プレイヤーバー内のボタン一覧（実測・日本語UI）

| 親要素のクラス | aria-label |
| --- | --- |
| `previous-button` | 前へ |
| `rewind-button` | 10 秒巻き戻し |
| `play-pause-button` | 再生 |
| （クラス無し）| 30 秒早送り |
| `next-button` | 次へ |
| `like` / `dislike` | 高評価 / 低評価 |
| `volume` / `expand-volume` | ミュート |
| `playback-rate-dropdown-trigger` | 再生速度 |
| `repeat` | リピートオフ |
| `shuffle` / `expand-shuffle` | シャッフル |
| `expand-button` | プレーヤーのコントロール バーを表示 |
| `toggle-player-page-button` | プレーヤー ページを閉じる |
| `right-controls-buttons` | `#my-mode-toggle`（**この拡張が挿しているボタン**）|

`.previous-button` / `.next-button` / `.play-pause-button` はいずれも実在するので、
`pip-manager.js` にある `[aria-label="前へ"]` / `[aria-label="Previous track"]` の
フォールバックは**現状では到達しない死にコード**である。
言語を増やす方向に伸ばすのは筋が悪い（言語の数だけ増える）。
**削除して、見つからなければ `YTMLog` に警告を出して何もしない**のが正しい。
黙って失敗するより YTM 側の変更に気づけるほうが価値が高い。

---

## 8. `#movie_player`（YT Player API）

`document.querySelector('#movie_player')` で取れる。MAIN world からのみ。
YouTube IFrame API と同じ公開メソッドを持つ。

| メソッド | 実測 |
| --- | --- |
| `getVolume()` | 0-100 の実音量 |
| `isMuted()` | boolean |
| `getPlayerState()` | `1` = 再生中、`3` = バッファリング を観測 |
| `getCurrentTime()` | 秒（小数）|
| `getDuration()` | 秒 |
| `setVolume(v)` | 存在する。**ただし YTM のUIは追従しない**（§5.2）|
| `nextVideo()` / `previousVideo()` | 存在する。**未検証** |

`bar.updateVolume` が使える以上、音量で `#movie_player` を使う理由は無い。
`nextVideo` / `previousVideo` も DOM クリックで足りているので、
**現時点で `#movie_player` に依存する必要は無い。**

---

## 9. この文書の更新について

- 値を書き換えるときは**測ってから**書く。推測で更新しない
- 測り直したら測定日と Chrome のバージョンを更新する
- 新しく依存する内部名が増えたら §1.1 のリストに追加する。
  **あのリストが「YTM が変わったときに壊れる場所」の全量である**という状態を保つ
