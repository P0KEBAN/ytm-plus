# docs/

`ytm-plus` の開発ドキュメントのうち、**公開して差し支えないもの**を置く。

このリポジトリは公開されているため、開発ドキュメントは2箇所に分かれている。

| 場所 | git | 何を置くか |
| --- | --- | --- |
| `docs/` | **追跡する** | 隠す必要がないもの。技術的な調査結果、仕様メモ、設計の記録 |
| `private-docs/` | 追跡しない（`.gitignore`）| 開発計画、引き継ぎ、実機確認の記録など、公開する意味がないもの |

**判断に迷ったら `private-docs/` に置く。** そのうえで、失うと再取得コストが高いもの
（実機で測らないと分からない事実など）は `docs/` へ移す。

## 置いてあるもの

| ファイル | 内容 |
| --- | --- |
| [`YTM-INTERNALS.md`](./YTM-INTERNALS.md) | YouTube Music 内部構造の実測メモ。MAIN world から触れる API、プレイヤーバーの DOM 構造、音量のスケール、キューの正本、content script のスコープ制約。**YTM 側の変更で壊れたときに最初に見る場所** |
| [`ADAPTER-CONTRACT.md`](./ADAPTER-CONTRACT.md) | 新UIと再生エンジンの境界（Player Adapter）の**設計判断の記録**。なぜその形にしたか、採らなかった案、実機で確かめ残していること。**形そのものは `src/js/newui/adapter/types.js` が正本** |

`docs/` の外にも、git で追跡している設計ドキュメントがある。

| ファイル | 内容 |
| --- | --- |
| [`../prototype/now-playing/SPEC.md`](../prototype/now-playing/SPEC.md) | 新 Now Playing UI の仕様。モックから採った数値、背景グラデーションの生成レシピ、再現しきれなかった点、検証手順、プロトタイプの開き方。実装コードの隣に置くほうが乖離しにくいので `docs/` へは移していない |
| [`../src/js/newui/adapter/types.js`](../src/js/newui/adapter/types.js) | **Player Adapter の契約の正本。** 新UIが知ってよい状態と操作はこれだけ。理由は上の `ADAPTER-CONTRACT.md` |

## ここに置かないもの

- ユーザー個人の情報、APIキー、トークン、機器固有の設定
- upstream 由来の文書（`開発者説明書.md` はリポジトリ直下のまま置く）
- フェーズ計画と引き継ぎ（`private-docs/ROADMAP.md` / `HANDOFF.md`）
