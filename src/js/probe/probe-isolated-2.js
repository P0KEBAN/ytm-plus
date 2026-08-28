// ytm-plus Phase 4a 検証プローブ（一時ファイル）
// probe-isolated.js が window に生やした名前空間を、別ファイルから読めるかを見る。
// これもトップレベル宣言を持たない。
(() => {
  'use strict';
  const ns = window.__YTMPLUS_PROBE__;
  window.__YTMPLUS_PROBE_2__ = {
    ok: !!(ns && ns.value === 42),
    seen: ns ? { createdBy: ns.createdBy, value: ns.value } : null,
    note: '同一エントリ内の別ファイルから window 名前空間が読めるか',
  };
})();
