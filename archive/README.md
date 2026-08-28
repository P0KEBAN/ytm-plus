# archive/

manifest.json から読み込まれておらず、実働していないファイルの退避先。

削除ではなく移動にとどめている。理由は、新UIの実装過程で参照したくなる可能性があるため。
実際に不要と確認できた時点で削除する（ロードマップ Phase 7 以降）。

| ファイル | 退避理由 |
| --- | --- |
| `lyrics-ui.js` | リポジトリルートにあった古いコピー（6,902行）。実働しているのは `src/js/module/lyrics-ui.js`（7,044行）。同名ファイルが2つあると誤編集事故が起きるため退避した |
| `animetion.js` | 冒頭コメントに「manifest の content_scripts で lyrics-ui.js より前に読み込まれる」とあるが、実際には manifest に記載がなく一度も読み込まれていない。コメントが実態と食い違っており誤解の元になるため退避した |
| `local-discord.js` | 「Discord presence integration has been removed.」と書かれた2行のプレースホルダー。中身がない |

## 注意

- ここのファイルは検証コマンド（`node --check`）の対象外。
- 復活させる場合は manifest.json への追加とテストの追加をセットで行うこと。
