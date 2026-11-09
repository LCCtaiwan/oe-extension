# 用自己的藥表建立 GAS 手機查藥頁

這份教學給使用者和協助設定的 agent。先完成「自己的 GAS」，再照手機種類設定入口。iPhone 的 `.shortcut` 安裝檔只適用 iPhone，而且裡面會存建立者的 GAS 網址；不要直接把別人的安裝檔當成自己的設定。

## 1. 準備自己的 Google 試算表

建立一份試算表，第一個分頁放藥品清單。至少要有 `藥名` 欄；建議也放 `批價碼` 和 `ATC碼`，這樣才能顯示院內代碼，並依 ATC 分出同成分、同機轉。例子：

| 批價碼 | 藥名 | ATC碼 | 劑型 |
| --- | --- | --- | --- |
| DEMO001 | Empagliflozin 10 mg | A10BK03 | 口服 |

可接受的欄名與資料解析方式以 [`src/formulary.js`](../src/formulary.js) 為準。`藥名` 也可寫成 `品名`、`藥品名稱`；`批價碼` 也可寫成 `院內代碼` 或 `藥品代碼`。表頭可在前 20 列內，沒有藥名的資料列會略過。範例資料只用來測試，請換成自己的清單。不要把真正的院內清單或病人資料上傳到公開 GitHub。

## 2. 建立並部署自己的 GAS

1. 在這份試算表選 **擴充功能 → Apps Script**。這樣新專案會綁在自己的藥表上。
2. 下載本專案**同一個版本**的 [`gas/Code.gs`](../gas/Code.gs) 與 [`gas/Index.html`](../gas/Index.html)。若是從原始碼製作，先在專案資料夾執行 `npm run build:gas`，再用產生的這兩個檔案。
3. 把 Apps Script 的 `Code.gs` **整份內容**換成下載的 `Code.gs`。新增一個 HTML 檔，名稱填 `Index`，再把 `Index.html` **整份內容**貼進去。儲存。
4. 選 **部署 → 新增部署作業 → 網頁應用程式**。執行身分選你自己；存取範圍依你的資料規則設定。部署時依畫面完成 Google 授權。
5. 複製部署後以 `/exec` 結尾的網址。用手機瀏覽器開啟，確認看得到頁面；再用自己的藥名查一次，確認有結果。`/dev` 是測試網址，只有專案編輯者可用，不要放進手機入口。

如果程式**不是**從試算表的「擴充功能」建立，可在 **專案設定 → 指令碼屬性** 加入 `SPREADSHEET_ID`；如果藥表不是第一個分頁，加入 `SHEET_NAME`。`GROQ_API_KEY` 只在需要 PICO、AI ATC 或自訂提示時設定。這些值放在你自己的 GAS 專案設定，不要寫進 GitHub。詳見 [Google 的指令碼屬性說明](https://developers.google.com/apps-script/guides/properties)與[網頁應用程式部署說明](https://developers.google.com/apps-script/guides/web)。

若你設定了 `ACCESS_TOKEN`，每個開啟網址都要加 `?k=你的存取碼`；查詢網址則是 `?k=你的存取碼&q=查詢文字`。這個存取碼會出現在持有者的連結中，不能當成保護敏感資料的完整登入機制。不要為了讓手機流程通過測試，就擴大試算表或部署的存取範圍。

## 3. iPhone：從分享選取文字查藥

在 iPhone 的「捷徑」App 建立捷徑，開啟「在分享表單中顯示」，接收文字。依序加入：

1. **URL 編碼**：輸入選「捷徑輸入」。
2. **URL**：輸入 `你的 /exec 網址?q=`，在 `=` 後插入上一個動作的「已編碼文字」變數。若有 `ACCESS_TOKEN`，改用 `你的 /exec 網址?k=你的存取碼&q=`，同樣把變數放在最後。
3. **顯示網頁顯示方式**（Show Web View）：輸入選上一步的 URL。

在其他 App 選取藥名 → 分享 → 選這個捷徑。頁面應顯示選取的文字與院內結果；關閉頁面後回到原 App。不要把帶自己網址或存取碼的 `.shortcut` 檔公開分享。這個流程曾在一部 iPhone 上完成實機驗證；新手機仍要自己測一次。詳見[現有 iPhone 驗證紀錄](iphone-shortcut-diagnosis.md)。

## 4. Android：加入主畫面

Android 不能安裝 iPhone 的 `.shortcut` 檔。最簡單的做法是：

1. 用 Android 的 **Chrome** 開啟自己的 `/exec` 網址；有 `ACCESS_TOKEN` 就開 `你的 /exec 網址?k=你的存取碼`。
2. 點 Chrome 右上角 **⋮ → 加到主畫面**（畫面也可能顯示「安裝應用程式」），照提示加入。
3. 從主畫面點「院內查藥」，輸入或貼上藥名查詢。也可以直接用 `你的 /exec 網址?q=已編碼的藥名` 測試網址帶入文字。

這是 GAS 網頁的主畫面入口；目前這個 GAS 頁面**不會**自動出現在 Android 的「分享至」清單。[Google Chrome 的主畫面捷徑說明](https://support.google.com/chrome/answer/15085120?co=GENIE.Platform%3DAndroid)可對照手機上的選單名稱。

專案另外有 [`web/` 網頁版](../web/)，它安裝成 Android 網頁 App 後可接收「分享」文字。**那是另一套資料設定**：它需要另行發布 Google Sheet 的 CSV 連結，知道連結的人可能讀到清單。只有資料允許這樣分享時才使用；設定方式見 [README 的 Mobile Web App 章節](../README.md#mobile-web-app-院內查藥)。Chrome 的[分享目標說明](https://developer.chrome.com/docs/capabilities/web-apis/web-share-target)也指出，網頁 App 要先安裝，才會出現在分享清單。

## 5. 給 agent 的完成檢查

可以把下面這段交給有權操作你的 Google 帳號的 agent，並附上**你自己的**藥表連結：

> 請照本教學，從我的 Google 試算表建立獨立的 Apps Script 網頁應用程式。先檢查藥表欄位，再用同一次 build 的 `gas/Code.gs` 與 `gas/Index.html` 部署；用測試藥名確認 `/exec` 頁面有結果。最後依我的手機種類設定 iPhone 捷徑或 Android 主畫面入口。不要把我的藥表、GAS 網址或金鑰寫進公開 GitHub，也不要自行放寬資料存取權限。請回報實際測試結果與仍需我在手機上完成的步驟。

- 藥表屬於使用者，表頭有 `藥名`，至少一筆測試資料可查到。
- GAS 的 `Code.gs` 與 `Index` 來自同一次 build；使用者自己的 `/exec` 頁面能開啟並查詢。
- iPhone 或 Android 依上方步驟實測；不要把 iPhone 的捷徑檔當作 Android 安裝檔。
- 專用 `/exec` 網址、`ACCESS_TOKEN`、`GROQ_API_KEY`、真實藥表內容都沒有提交到公開 repo。
- 更新已部署的 GAS 時，用 **部署 → 管理部署作業 → 編輯 → 新版本 → 部署**，再重開原 `/exec` 網址確認版本；只儲存程式或更新 GitHub 不會更新既有部署。
