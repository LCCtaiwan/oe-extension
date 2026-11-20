# develog — OpenEvidence Selection Opener (oe-extension)

## Current Goal

建立中央資料：院內查藥（GAS 手機頁、iPhone 捷徑、Chrome 擴充功能）統一讀「藥品儲位查詢中央資料」Google Sheet。
本 repo 為 `htlin222/oe-extension` 的個人副本（`lcctaiwan/oe-extension`，PUBLIC）。工作分支 `air/central-sheet`（基於 `air/fast-gas-shortcut-page`）。

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
- 中央 Sheet 為私人；ID、`/exec` 網址、存取碼、帳號資訊只放 `.gas-deploy/DEPLOY.md`（gitignored）與 GAS 指令碼屬性，不進 repo。
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

- 2026-11-20（air，`air/central-sheet`，4f92df0）：決策＝擴充功能經 GAS 讀私人中央 Sheet（不公開 Sheet）；
  共用解析器略過「狀態＝停用」；GAS 新增 `?api=csv&k=`；擴充功能顯示 GAS ⚠️ 錯誤與登入頁錯誤；文件更新。測試 15/15。
- 2026-11-20：GAS「院內查藥 OE（中央資料）」以 clasp 建在門診藥局帳號（standalone，
  SPREADSHEET_ID＋SHEET_NAME=儲位，部署「所有人」；ACCESS_TOKEN 已移除）。部署資訊在 `.gas-deploy/DEPLOY.md`。
  個人帳號另有一個未部署的空殼專案（`.gas-deploy/.clasp.personal.json`）。

- 2026-11-20：新增 `docs/install-guide.html` 同仁安裝教學（Chrome／iPhone／Android、疑難排解）；不含任何網址或存取碼，
  同仁貼上管理者給的連結後在瀏覽器端產生三種網址；管理者也可傳 `install-guide.html#<連結>` 自動帶入。
  已在桌面與手機寬度（375px、深色）檢查，無橫向捲動，連結產生與錯誤提示正常。

- 2026-11-20：依使用者決定移除 ACCESS_TOKEN（GAS 不再檢查 k=，拿到 /exec 網址即可查）；教學頁的 k= 改為選填。
  發布的教學頁改用內建網址的本機版（`.gas-deploy/install-guide.private.html`），repo 版仍不含網址。
  驗證：無 k= 時 `?api=csv` 解析 1511 項、`?api=lookup` 正常。

- 2026-11-20：擴充功能 zip（v0.1.9，67 KB，不含網址）內嵌於發布的教學頁，按鈕經 artifact `downloads` 能力下載；
  repo 版教學仍寫「向管理者拿 zip」。改版需重建 zip 並重新發布教學頁。

## Verification Status

- 已驗（2026-11-20，curl）：`?api=csv` 200，1529 列；擴充功能解析器得 1511 項（排除停用 18），1387 項有 ATC，無缺欄；
  `?api=lookup` 正常回院內品項與儲位；無 k= 回 ⚠️ 存取碼錯誤；`?k=` 頁面 200。
- 未驗：Chrome 擴充功能實際貼網址同步；iPhone 捷徑改新網址後實機查藥。

## Current Checkpoint

GAS 已部署並驗證；待使用者在擴充功能與 iPhone 捷徑換上新網址。

## Recommended Next Step

1. 擴充功能：設定 → 院內品項 → 貼 DEPLOY.md 的 CSV 網址 → 儲存並同步。
2. iPhone 捷徑 URL 改成 DEPLOY.md 所列網址並實機測試。
3. 決定是否刪除個人帳號的空殼 GAS；之後再決定院內查藥線是否合併回 `main`（需先問）。
