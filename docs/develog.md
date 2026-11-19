# develog — OpenEvidence Selection Opener (oe-extension)

## Current Goal

尚未指定新任務。本 repo 為 `htlin222/oe-extension` 的個人副本（`lcctaiwan/oe-extension`），
目前以 `main`（v0.1.8）為基準，待決定接下來要開發或合併的方向。

## Stack And Run Commands

- Chrome Extension，Manifest V3，純 JavaScript（ES Modules）/ CSS / HTML，無框架、無 runtime 依賴。
- Node 24（本機 v24.11.0），只用於測試與打包。
- 主要檔案：
  - `src/background.js` — service worker、右鍵選單、開分頁 / side panel
  - `src/content.js` / `content.css` — 選字工具列
  - `src/sidepanel.*`、`src/oe-sidepane.js` — side panel 內嵌 OpenEvidence
  - `src/nccn-redirect.js` — NCCN 連結改寫
  - `src/options.*` — 設定頁、查詢紀錄、Groq BYOK、自訂 prompt
- 指令：

```bash
npm test          # node scripts/run-tests.mjs（tests/*.test.mjs）
npm run build     # 產出 dist/extension 與 dist/oe-extension-v<version>.zip
make build        # 先測試再打包
```

- 載入：`chrome://extensions` → 開發人員模式 → 載入未封裝項目 → 選 `dist/extension`。
- Release：GitHub Actions 於 tag / release 時測試、打包 zip 與 crx。

## Important Project Rules

- Groq API key 只存在 `chrome.storage.local`，不得寫入 repo 或打包檔。
- 版本號需同時更新 `manifest.json` 與 `package.json`（release workflow 會驗證）。
- 雙機分支規則：Air 用 `air/<主題>`、Mac mini 用 `mini/<主題>`；不直接改 `main`。

## Branches（2026-11-19 盤點）

| 分支 | 內容 | 狀態 |
| --- | --- | --- |
| `main` | v0.1.8：NCCN 連結改寫、歷史紀錄同步、side panel 等 | 基準 |
| `origin/feature/hospital-formulary` | 院內品項查詢（v0.1.9）、ATC 查詢（RxClass → Groq 備援）、院內查藥 mobile web app、LINE bot（GAS） | 2026-11-05，未合併 |
| `origin/feature/gas-mobile` | GAS 文字 API、iPhone 捷徑 / Web View 查藥流程與說明 | 2026-11-09，未合併 |
| `origin/air/fast-gas-shortcut-page` | 接續 gas-mobile：先顯示捷徑頁再載入藥品表（C-001）、個人 GAS 設定文件（C-002） | 2026-11-09，未合併 |

## Completed Work

- 2026-11-19（air）：clone 到 `Desktop/PGY許願池/openevidence extention`；`npm test` 13/13 通過；
  建立本 develog（分支 `air/develog`）。

## Current Checkpoint

`main` 乾淨、測試通過；三條功能分支皆未合併回 `main`。

## Recommended Next Step

決定是否要把 `feature/hospital-formulary` → `feature/gas-mobile` → `air/fast-gas-shortcut-page`
這條院內查藥線整理後合併回 `main`，或另開新功能。
