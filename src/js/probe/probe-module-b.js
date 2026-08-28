// ytm-plus Phase 4a 検証プローブ（一時ファイル）
// probe-module.js から相対パスで import される。
// ここでも `config` を宣言し、モジュールスコープが独立していることを示す。
const config = 'module-b-scope-config';
export function hello() {
  return 'OK: 相対 import 解決 / ' + config;
}
