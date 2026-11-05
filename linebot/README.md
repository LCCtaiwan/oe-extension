# 院內查藥 LINE Bot

傳藥名給 Bot（學名、商品名、中文名或批價碼），它會回覆：

- **院內有此藥**：品項、劑型、健保價／自費價、儲位，批價碼點一下就能複製
- **同成分其他品項**
- **同機轉**：ATC 前 5 碼相同的院內品項

每則回覆下方都有 OpenEvidence、UpToDate、PubMed 按鈕，會用同一段文字查詢。院內清單比對不到時，Bot 會查 NLM RxClass 找出 ATC 類別，例如 Lipitor 會對到 atorvastatin，再列出院內的同成分、同機轉品項。

- **群組**：把 Bot 拉進群組後，標記它（`@院內查藥 rosuvastatin`）或輸入 `? rosuvastatin` 才會回覆，平常的對話不會打擾。
- **資料來源**：程式放在院內清單那份 Google 試算表的 Apps Script 裡，直接讀試算表。跟手機 App、Chrome 擴充功能用同一份資料，改試算表就全部生效。
- **費用**：Bot 只用「回覆訊息」，LINE 不收費，Google Apps Script 也免費。

> ⚠️ 加 Bot 好友的人都查得到清單內容，而且訊息會經過 LINE 的伺服器，請勿傳送病人資料。

---

## 設定步驟（約 15 分鐘，只需做一次）

### A. 建立 LINE 官方帳號與 Messaging API

1. 打開 <https://manager.line.biz>，用你的 LINE 帳號登入，按「建立 LINE 官方帳號」。帳號名稱建議填「院內查藥」，就是同事加好友時看到的名字。
2. 建好後，在官方帳號後台：**設定 → Messaging API → 啟用 Messaging API**，選一個「服務提供者」（Provider，第一次就新建一個，例如醫院名稱）。
3. 同樣在後台：
   - **設定 → 回應設定**：開啟「Webhook」，關閉「自動回應訊息」。歡迎訊息也可以關掉，Bot 會自己傳使用說明。
   - **設定 → 帳號設定 → 功能切換**：「加入群組或多人聊天室」選「接受邀請加入群組或多人聊天室」。
4. 打開 <https://developers.line.biz/console/>，進到剛剛那個 Provider 底下的 channel，切到 **Messaging API** 分頁。在最下面的「Channel access token (long-lived)」按 **Issue**，把產生的一長串金鑰複製起來，下一段會用到。

### B. 把程式放進 Google 試算表

1. 打開院內清單那份 Google 試算表。如果還是 `.xlsx`，先用「檔案 → 儲存為 Google 試算表」轉成試算表。
2. 點 **擴充功能 → Apps Script**。
3. 刪掉編輯器裡原本的程式碼，貼上 [`LineBot.gs`](LineBot.gs) 的全部內容。可以從 GitHub 檔案頁按「Raw」再全選複製。按 💾 儲存。
4. 點左側 ⚙️ **專案設定** → 最下面的 **指令碼屬性** → **新增指令碼屬性**：
   - 屬性：`LINE_CHANNEL_ACCESS_TOKEN`
   - 值：剛剛複製的 Channel access token
   - 如果清單不在試算表的第一個工作表，再新增屬性 `SHEET_NAME`，值填工作表名稱。
5. 回到編輯器，上方函式選單選 **testLookup**，按 **執行**。
   - 第一次會要求授權：選你的 Google 帳號 →「進階」→「前往（不安全）」→「允許」。這是你自己寫的程式，Google 沒審核過才會這樣顯示。
   - 下方「執行記錄」出現 rosuvastatin 的查詢結果，就代表試算表讀得到。
6. 右上角 **部署 → 新增部署作業**：
   - 類型（⚙️）：**網頁應用程式**
   - 執行身分：**我**
   - 誰可以存取：**所有人**
   - 按「部署」，複製 **網頁應用程式網址**（`https://script.google.com/macros/s/…/exec`）。

### C. 把網址接回 LINE

1. 回到 LINE Developers 的 **Messaging API** 分頁，在「Webhook URL」貼上剛剛的網址 → **Update**，再開啟 **Use webhook**。
2. 按 **Verify**。如果顯示 302 之類的錯誤可以先忽略，這是 Apps Script 會轉址造成的，直接用下一步實際傳訊息測試。
3. 用手機掃同一頁上方的 QR code 加好友，傳 `rosuvastatin`，幾秒內應該會收到回覆。
4. 把 QR code 或加好友連結分享給同事；要在群組用，就從群組邀請「院內查藥」加入。

---

## 之後的維護

- **院內清單更新**：直接改 Google 試算表，Bot 每次查詢都會讀最新的內容。
- **程式更新**（GitHub 上的 `LineBot.gs` 有新版時）：
  1. 在 Apps Script 貼上新程式並儲存。
  2. **部署 → 管理部署作業 → ✏️ 編輯 → 版本選「新版本」→ 部署**。網址不變，不用改 LINE 的設定。
- **查問題**：Apps Script 左側「執行作業」可以看到每次被呼叫的記錄和錯誤訊息。

## 限制

- Apps Script 讀不到 HTTP 標頭，所以無法驗證 LINE 的簽章（`X-Line-Signature`）。就算有人假冒 LINE 呼叫網址，也拿不到資料，因為回覆只會透過 LINE 官方的回覆 API 送給真正傳訊息的人。
- 第一次查詢或很久沒人用時，Apps Script 需要暖機，回覆可能要等 2～5 秒。
- RxClass 只認得英文藥名，中文藥名只能靠院內清單比對。
