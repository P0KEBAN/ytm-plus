// ytm-plus Phase 4a 検証プローブ（一時ファイル・ES モジュール）
// content script から import(chrome.runtime.getURL(...)) で読み込まれる。
//
// ここでの `config` はモジュールスコープなので、
// content script のグローバルにある `config`（namespace.js:188）とは無関係のはず。
const config = 'module-scope-config';

export async function report() {
  const out = {
    moduleScopedConfig: config,
    // モジュール内から chrome.* が使えるか（isolated world の特権を保てているか）
    chromeRuntimeId: (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) || null,
    chromeStorageUsable: null,
    nestedImport: null,
    domReachable: !!document.querySelector('ytmusic-player-bar'),
    importMetaUrl: import.meta.url,
  };

  try {
    await new Promise((res, rej) => {
      chrome.storage.local.get(['__ytmplus_probe_nonexistent__'], (v) =>
        chrome.runtime.lastError ? rej(chrome.runtime.lastError) : res(v));
    });
    out.chromeStorageUsable = true;
  } catch (e) {
    out.chromeStorageUsable = String(e && e.message || e);
  }

  // モジュール同士の相対 import が chrome-extension:// 上で解決できるか
  try {
    const b = await import('./probe-module-b.js');
    out.nestedImport = b.hello();
  } catch (e) {
    out.nestedImport = 'NG: ' + String(e && e.message || e);
  }

  return out;
}
