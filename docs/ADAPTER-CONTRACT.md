# Player Adapter の契約と、その設計判断

作成: 2026-09-07（Phase 6a）/ 契約の実体: `src/js/newui/adapter/types.js`

このファイルは **「なぜこの形にしたか」** を残す場所である。
**「どういう形か」はコード（`types.js`）が正本**なので、ここには型を書き写さない。
型を変えたときは `types.js` を直し、判断が変わったときだけこのファイルを直す。

---

## 1. Adapter とは何か

新UIと再生エンジンのあいだの唯一の約束事である。

```text
YouTube Music (MAIN world: bar.volume / repeatMode / queue.store …) ┐
YouTube Music の DOM（ボタン・キュー行）                            ├→ YtmAdapter  ┐
<video> 要素（currentTime / paused）                                ┘              │
                                                                                   ├→ 新UI
モックデータ ──────────────────────────────────────→ MockAdapter ┘
```

**同じ契約を2つの実装が満たす。** UI は契約しか知らない。
`tests/helpers/adapter-contract.mjs` の1本のテストを両方に当てることで、
それが本当に成り立っていることを機械的に確かめる。

Phase 6a の時点では `MockAdapter` だけが存在する。`YtmAdapter` は Phase 6c。

---

## 2. なぜプロトタイプの状態をそのまま契約にしなかったか

Phase 5 のプロトタイプは `state` オブジェクトひとつに、**性質の違う3種類を混ぜて**持っていた。

1. 再生エンジンが正解を持つ値（再生状態・音量・リピート・シャッフル・キュー・歌詞）
2. UI が勝手に決めてよい値（追従・表示切替・コントラスト・動き）
3. 毎フレーム導出するだけで保存しなくてよい値（現在行・再生位置）

そして 1 を **「UI が書き換えたら、それがそのまま真実になる」** 構造で扱っていた。
モックの中では正しく動くが、実機ではここが逆転する。**YouTube Music が真実を持ち、
UI は結果を受け取る側になる。** この転換が Phase 6 の本体である。

`prototype/now-playing/SPEC.md` §7 に、Codex のレビューで洗い出した8つの具体的な破綻がある。
以下はそれぞれへの対処と、その理由である。

---

## 3. 主要な設計判断

### 3.1 再生状態は真偽値3つではなく単一の列挙にする

プロトタイプは `mediaPaused` / `playing` / `buffering` の真偽値3つを持っていた。
**8通りのうち5通りはあり得ない組み合わせ**で、型がそれを許してしまう。

`'idle' | 'playing' | 'buffering' | 'paused' | 'ended'` の1つの値にした。

YouTube Music 側には実測で意味の違う3つのソースがある（`docs/YTM-INTERNALS.md` §4.3）。

| ソース | 意味 |
| --- | --- |
| `video.paused` | ユーザーが止めたか |
| `bar.playing` | 再生ボタンの見た目 |
| `#movie_player.getPlayerState() === 3` | バッファリング中 |

**どれを信じるかの判断を1箇所に集める**のが目的である。UI は `status` だけを見る。
`detectBuffering` の capability が false のときは、単に `buffering` が現れなくなるだけで、
UI 側の分岐は変わらない。

### 3.2 再生位置は購読で配らない ★もっとも効く判断

歌詞の RAF ループは毎フレーム現在位置を必要とする。しかしそのために
スナップショット全体を毎フレーム作り直して全購読者へ配るのは無駄である。
読み取り経路を2つに分けた。

| 経路 | 返すもの | 呼ばれ方 |
| --- | --- | --- |
| `subscribe(fn)` | スナップショット全体 | 離散的な変化のときだけ |
| `getPosition()` | `{ position, duration }` だけ | 毎フレーム。**通知を発生させない** |

これは Phase 4c の #9（`lyrics-ui.js` の `_cachedVideoEl` を RAF が毎フレーム参照している）と
正面から噛み合う。`<video>` 要素の解決・キャッシュ・再取得を Adapter が引き受け、
`getPosition()` がその唯一の窓口になる。

**ここを分けないと ROADMAP Phase 6 の完了条件「新UIが YouTube Music 固有 DOM を
直接参照しない」を満たせない。** 分けなければ、UI がどこかで `<video>` を掴むことになる。

契約テストの「再生位置が進むだけでは通知が発生しない」がこれを守っている。

### 3.3 キュー項目には itemId と videoId の両方を持たせる

- `itemId` … キュー内の「この項目」を指す。**選曲に使う**
- `videoId` … 曲そのもの。**歌詞取得のキーに使う**

**同じ曲がキューに2回入っていることがある。** `videoId` だけでは
「どちらの項目が現在曲か」を表せない。

`trackIndex`（配列の位置）は捨てた。実キューは挿入・削除・並べ替えがあるので、
位置は次の瞬間には別の曲を指す。

> **未実測（Phase 6b で確認する）**: YouTube Music の
> `bar.queue.store.getState().queue` に `nextQueueItemId` というキーがあったので、
> 項目にIDが振られている可能性が高い。**まだ確認していない。**
> 無ければ `videoId#index` の合成IDへ落とすが、その場合は並べ替えで壊れることを
> Adapter が知っている状態にする。**ここは推測で決めないこと。**

### 3.4 歌詞スナップショットは自分がどの曲のものかを持つ

歌詞は非同期で遅れて届く。**曲を変えた直後に「前の曲の歌詞」が届くことが実際に起きる。**
`LyricsSnapshot.videoId` があれば、UI は
`lyrics.videoId !== player.track.videoId` のあいだ表示しない、で防げる。

プロトタイプは `Track` が歌詞を抱えていたので、この事故が構造的に起きなかった。
つまり **穴があることに気づけない形**だった。歌詞を曲から切り離した結果、
穴が見えるようになり、同時にそれを塞ぐ手段も型の中に入った。

### 3.5 訳文は行の中ではなく行IDの対応表で持つ

`LyricLine` に `translation?` を持たせると、翻訳が届くたびに `lines` 配列を
作り直すことになる。UI は `lines` の同一性を見て「歌詞が変わったか」を判断するので、
**翻訳の到着で歌詞 DOM が丸ごと再構築される。**

`translation.byLineId`（行ID → 訳文）に分けたことで、
`player.js` は訳文だけを既存の要素へ差し込める（`applyTranslations()`）。
取得状態も歌詞本体と独立するので「原文は出ているが翻訳は取得中」を表現できる。

### 3.6 操作はすべて目標値指定にする

`cycleRepeat()` / `toggleShuffle()` のような**相対操作は契約に置かない。**
外部（YouTube Music 本体のUI、キーボードショートカット、別タブ）で値が変わると、
UI が思っている現在値と実際の現在値がずれ、トグルの結果が予測できなくなる。

`setRepeat(mode)` / `setShuffle(enabled)` / `setMuted(enabled)` にした。
UI 側は「直近に Adapter から受け取った値」から次の目標値を計算して渡す。

YouTube Music 側にはトグル操作しか無い（`.repeat` の DOM クリック、
`onRepeatButtonClick()`）。**その変換は Adapter の内側でやる。**
目標値に届くまで押し、**毎回読み直して確認する**。回数を決め打ちしない。

`play()` / `pause()` を `togglePlay()` にしなかったのも同じ理由である。

### 3.7 操作は失敗しうる。それを型に入れる

すべての操作が `Promise<OpResult>` を返す。**失敗は例外ではなく戻り値**で表す。
理由は `unsupported` / `not-found` / `timeout` / `rejected` の4つ。

加えて `pending` を状態に載せた。`setRepeat('ONE')` を呼ぶと、
まず `pending.repeat === true` のスナップショットが来て、
確定してから `repeat: 'ONE'` / `pending.repeat: false` が来る。

**UI は操作の成功を仮定しない。** ボタンを押しても自分の状態は書き換えず、
Adapter から返ってきた正規の状態で確定させる。

### 3.8 capabilities で「できないこと」を伝える

MAIN world のブリッジが死ぬと、音量・リピート・シャッフルの**状態が読めなくなる**
（`docs/YTM-INTERNALS.md` §7.2：DOM 側に言語非依存の手掛かりが皆無）。
そのとき該当の capability を false にし、**UI がそのボタンを無効化する。**

押しても何も起きないボタンを黙って出すのが最悪の振る舞いである。

### 3.9 `seekToLyricLine(id)` は置かない

UI 側で行IDを秒へ解決してから `seek(sec)` を出す。
Adapter が UI の歌詞行IDを知る必要はなく、知らないほうが境界が明確になる。

### 3.10 UIローカル状態は Adapter に入れない

境界の判断基準は **「YouTube Music を再起動しても復元されるべき値か」**。

| Adapter が持つ | UI が持つ |
| --- | --- |
| 音量 / 消音 / リピート / シャッフル / 再生状態 / 位置 / キュー / 歌詞 | 表示切替 / 歌詞の自動追従 / 現在行 / コントラスト / 背景の動き / 直前の非ゼロ音量 / ドラッグ中 |

**消音は2つに分けた。** `muted` は YouTube Music 自身が持っている（`bar.isMuted`）ので Adapter。
一方 SPEC.md §2 の `toggleMute` には「音量0のときは直前の非ゼロ値へ戻す」という
別の機能が混ざっていた。そちらは UI 独自の親切機能なので `uiState.lastNonzeroVolume` に置いた。

**翻訳は「見せたい」と「取れた」を分けた。** UI が `setTranslationWanted(true)` を出し、
取れたかどうかは `lyrics.translation.status` で返る。

設定値の保存（背景の粒の強さ / 明るさ / 動きの速さ）も UI 側の関心なので、
Adapter の状態モデルには入れない。

---

## 4. 採らなかった案

| 案 | 採らなかった理由 |
| --- | --- |
| スナップショットを毎フレーム配る（位置も購読で流す） | 歌詞 RAF のために全購読者へ毎フレーム通知が飛ぶ。§3.2 |
| `Track` に全曲分の歌詞を持たせる（プロトタイプの形） | 歌詞は遅延取得。曲の一部として持つと取り違えに気づけない。§3.4 |
| キューを `Track[]` + `trackIndex` で表す | 実キューの挿入・削除・並べ替えで位置がずれる。§3.3 |
| 操作を例外で失敗させる | 呼び出し側が try/catch を書き忘れると黙って壊れる。戻り値なら型で見える |
| `togglePlay()` / `cycleRepeat()` のような相対操作 | 外部変更とずれる。§3.6 |
| UI 側で操作結果を先取りして描画する（楽観的更新） | 実機で失敗したときに嘘の表示が残る。Phase 6a では採らない。速さが問題になったら、失敗時に必ず巻き戻すことをセットで設計する |

---

## 5. Phase 6b で実機に当たって確かめること

**推測で埋めないこと。** ここが埋まるまで `YtmAdapter` の実装を始めない。

| # | 測ること | 埋まらないと何が困るか |
| --- | --- | --- |
| 1 | `bar.queue.store.getState().queue.items[]` に**安定した項目IDがあるか**（`nextQueueItemId` の周辺） | `itemId` の正本が決まらない。設計の根幹（§3.3） |
| 2 | `bar.queue.store.subscribe()` が使えるか | 使えれば `replay-manager.js` の1秒ポーリングを消せる。`YTM-INTERNALS.md` §6 に「未確認」と明記された宿題 |
| 3 | `.repeat` をクリックしてから `bar.repeatMode` が更新されるまでの遅延 | §3.6 の確認ループのタイムアウト値の根拠がない |
| 4 | 低電力GPUでの背景の実測 | `prototype/now-playing/SPEC.md` が Phase 6 の完了条件に入れろと書いている |

実機プローブの取り出し方と、**測り終わったら必ず消すこと**は
`docs/YTM-INTERNALS.md` §1.3 にある。

---

## 6. 実装の置き場所

```text
src/js/newui/
  package.json             ← このフォルダ配下を ES モジュールと宣言するだけ（Chrome は読まない）
  adapter/
    types.js               ← 契約の正本。純粋。DOM にも chrome API にも触らない
    mock-adapter.js        ← モック実装（Phase 6a）
    ytm-adapter.js         ← 実機実装（Phase 6c で作る）
    ytm-bridge-main.js     ← MAIN world 側（Phase 6c）
    ytm-dom.js             ← ★YouTube Music の DOM セレクタの全量をここに集約する（Phase 6c）
tests/
  adapter-contract.test.mjs      ← MockAdapter に契約を当てる
  helpers/adapter-contract.mjs   ← 契約テストの本体。実装非依存
```

`ytm-dom.js` にセレクタを全部集めるのは、ROADMAP Phase 6 の完了条件
「YouTube Music の DOM 構造に依存する箇所が Adapter 内に列挙されている」を
**ファイル1つで**満たすためである。YouTube Music が変わったら、
`ytm-dom.js` と `ytm-bridge-main.js` の内部名リスト（7つ）だけを見れば済む状態を保つ。

### テストの方針

既存テスト9本は「ソースコードを文字列として正規表現で検査する」方式で、
関数名を変えただけで壊れる。**リファクタリングの安全網にならない。**

契約テストは `tests/replay-pending-write.test.mjs` と同じく、
**実際に動かして振る舞いを見る**方式で書いてある。
`tests/helpers/` は `node --test tests/*.mjs` のグロブに入らないので、
本体をそこに置いて呼び出し側から `runAdapterContract()` を呼ぶ形にした。
Phase 6c で `YtmAdapter` にも同じ本体を当てる。

---

## 7. プロトタイプの開き方が変わったこと

Phase 6a で Adapter を `src/js/newui/adapter/` に置き、プロトタイプがそれを
`import` するようにした。実機の新UIは `import(chrome.runtime.getURL(...))` で
読み込む ES モジュールなので、**同じコードを共有するには ES モジュールにするしかない。**

ES モジュールは `file://` では読めない（origin が null になり CORS で弾かれる）。
そのため **index.html をダブルクリックで開くことはできなくなった。**

```bash
node prototype/now-playing/serve.cjs
# → http://localhost:8080/prototype/now-playing/
```

依存は無い。Node だけで動く数十行の静的サーバーで、ループバックにしか bind しない。
自動検証（`check.cjs`）は同じサーバーを内蔵しているので、別途起動する必要はない。

**代わりに得たもの**: Adapter のコードの実体が1箇所だけになり、
プロトタイプで通した契約がそのまま実機へ持っていける。
`prototype/` 用と `src/` 用に同じものを2つ書く状態を避けられた。
