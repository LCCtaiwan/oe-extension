import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = fileURLToPath(new URL("..", import.meta.url));

// The committed LineBot.gs must match its sources.
execFileSync(process.execPath, ["scripts/build-linebot.mjs", "--check"], { cwd: root, stdio: "inherit" });

const source = readFileSync(new URL("../linebot/LineBot.gs", import.meta.url), "utf8");

const SHEET = [
  ["批價碼", "藥名", "P1儲位", "藥庫", "健保價", "自費價", "ATC碼", "藥理代碼", "劑型"],
  ["OROSU", "Rosuvastatin (Crestor) 冠脂妥 10mg/tab", "A89", "A151", "10.3", "12", "C10AA07", "DN203", "O"],
  ["OATOR40", "Atorvastatin (Tulip) 妥寧 40 mg/tab", "A84", "A091", "16.6", "20", "C10AA05", "DN201", "O"],
  ["OATOZ", "Atozet (Ezetimibe/Atorvastatin) 優泰脂 10/20 mg/tab", "A43", "", "15.9", "19", "C10BA05", "DN301", "O"],
  ["ODAPA", "Dapagliflozin (Forxiga) 福適佳 10mg/tab", "A26", "", "25.4", "30", "A10BK01", "GE301", "O"],
];
const RX = { lipitor: [["atorvastatin", "C10AA", "HMG CoA reductase inhibitors"]] };

function makeRuntime({ flexStatus = 200 } = {}) {
  const replies = [];
  const props = { LINE_CHANNEL_ACCESS_TOKEN: "test-token" };
  const response = (code, body) => ({ getResponseCode: () => code, getContentText: () => body });
  const context = {
    console: { log() {}, warn() {}, error() {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (key) => props[key] || null }) },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ({
        getSheets: () => [{ getDataRange: () => ({ getDisplayValues: () => SHEET }) }],
      }),
    },
    ContentService: { createTextOutput: (text) => ({ text }) },
    UrlFetchApp: {
      fetchAll: (requests) =>
        requests.map((request) => {
          const name = new URL(request.url).searchParams.get("drugName").toLowerCase();
          const hit = RX[name];
          if (!hit) return response(404, "");
          return response(
            200,
            JSON.stringify({
              rxclassDrugInfoList: {
                rxclassDrugInfo: hit.map(([ingredient, classId, className]) => ({
                  minConcept: { name: ingredient },
                  rxclassMinConceptItem: { classId, className, classType: "ATC1-4" },
                })),
              },
            })
          );
        }),
      fetch: (url, options) => {
        const payload = JSON.parse(options.payload);
        replies.push({ url, auth: options.headers.Authorization, payload });
        const isFlex = payload.messages[0].type === "flex";
        return response(isFlex ? flexStatus : 200, isFlex && flexStatus !== 200 ? '{"message":"invalid"}' : "{}");
      },
    },
    // No URL / TextDecoder / fetch here: Apps Script doesn't have them.
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  const post = (...events) =>
    context.doPost({ postData: { contents: JSON.stringify({ destination: "U0", events }) } });
  return { context, replies, post };
}

const userText = (text) => ({
  type: "message",
  replyToken: "rt-1",
  source: { type: "user", userId: "U1" },
  message: { type: "text", id: "1", text },
});
const groupText = (text, mention) => ({
  type: "message",
  replyToken: "rt-2",
  source: { type: "group", groupId: "G1", userId: "U1" },
  message: { type: "text", id: "2", text, ...(mention ? { mention } : {}) },
});

// Collect every text in a Flex structure.
function texts(node, out = []) {
  if (Array.isArray(node)) node.forEach((child) => texts(child, out));
  else if (node && typeof node === "object") {
    if (node.type === "text") out.push(node.text);
    Object.values(node).forEach((child) => texts(child, out));
  }
  return out;
}

// Flex constraints LINE enforces.
function assertValidFlex(message) {
  assert.equal(message.type, "flex");
  assert.ok(message.altText.length > 0 && message.altText.length <= 400);
  assert.ok(JSON.stringify(message).length < 50000);
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== "object") return;
    if (node.type === "box") assert.ok(node.contents.length > 0, "empty box");
    if (node.type === "text") assert.ok(node.text.length > 0, "empty text");
    if (node.type === "uri") assert.ok(node.uri.length <= 1000 && node.label.length <= 20);
    if (node.type === "clipboard") assert.ok(node.label.length <= 20 && node.clipboardText.length > 0);
    Object.values(node).forEach(walk);
  };
  walk(message.contents);
  if (message.contents.type === "carousel") assert.ok(message.contents.contents.length <= 12);
}

// 1:1 chat: direct hit plus the same-mechanism statin.
{
  const { replies, post } = makeRuntime();
  const out = post(userText("rosuvastatin"));
  assert.equal(out.text, "OK");
  assert.equal(replies.length, 1);
  assert.equal(replies[0].url, "https://api.line.me/v2/bot/message/reply");
  assert.equal(replies[0].auth, "Bearer test-token");
  assert.equal(replies[0].payload.replyToken, "rt-1");
  const flex = replies[0].payload.messages[0];
  assertValidFlex(flex);
  const all = texts(flex.contents);
  assert.ok(all.includes("院內有此藥（1）"));
  assert.ok(all.includes("Rosuvastatin (Crestor) 冠脂妥 10mg/tab"));
  assert.ok(all.includes("同機轉 · ATC C10AA（1）"));
  assert.ok(all.includes("Atorvastatin (Tulip) 妥寧 40 mg/tab"));
  assert.ok(all.some((t) => t.startsWith("批價碼 OROSU")));
  const json = JSON.stringify(flex);
  assert.ok(json.includes('"clipboardText":"OROSU"'));
  assert.ok(json.includes("https://www.openevidence.com/ask?query=rosuvastatin"));
  assert.ok(json.includes("https://pubmed.ncbi.nlm.nih.gov/?term=rosuvastatin"));
}

// 1:1 chat, Chinese brand name and an optional "院內" prefix.
{
  const { replies, post } = makeRuntime();
  post(userText("院內 冠脂妥"));
  assert.ok(texts(replies[0].payload.messages[0].contents).includes("Rosuvastatin (Crestor) 冠脂妥 10mg/tab"));
}

// Group chatter that doesn't address the bot is ignored.
{
  const { replies, post } = makeRuntime();
  post(groupText("rosuvastatin 今天缺貨嗎"));
  assert.equal(replies.length, 0);
}

// Group @mention: the mention is cut out of the query.
{
  const { replies, post } = makeRuntime();
  post(
    groupText("@院內查藥 rosuvastatin", {
      mentionees: [{ index: 0, length: 5, type: "user", userId: "Ubot", isSelf: true }],
    })
  );
  assert.equal(replies.length, 1);
  assert.ok(texts(replies[0].payload.messages[0].contents).includes("查詢：rosuvastatin"));
}

// Mentioning someone else isn't addressed to the bot.
{
  const { replies, post } = makeRuntime();
  post(groupText("@Amy rosuvastatin", { mentionees: [{ index: 0, length: 4, type: "user", userId: "U9" }] }));
  assert.equal(replies.length, 0);
}

// Group "? Lipitor": not in the list by name, RxClass maps it to atorvastatin.
{
  const { replies, post } = makeRuntime();
  post(groupText("? Lipitor"));
  const flex = replies[0].payload.messages[0];
  assertValidFlex(flex);
  const all = texts(flex.contents);
  assert.ok(all.includes("院內沒有符合「Lipitor」的品項。"));
  assert.ok(all.includes("NLM RxClass：atorvastatin → ATC C10AA HMG CoA reductase inhibitors"));
  assert.ok(all.includes("院內同成分品項（2）"));
  assert.ok(all.includes("Atorvastatin (Tulip) 妥寧 40 mg/tab"));
  assert.ok(all.includes("同機轉 · ATC C10AA（1）"));
  assert.ok(all.includes("Rosuvastatin (Crestor) 冠脂妥 10mg/tab"));
}

// Unknown name: reply still explains, no crash.
{
  const { replies, post } = makeRuntime();
  post(userText("zzzunknowndrug"));
  const all = texts(replies[0].payload.messages[0].contents);
  assert.ok(all.includes("院內沒有符合「zzzunknowndrug」的品項。"));
  assert.ok(all.includes("RxClass 也查不到這個藥名（只支援英文藥名）。"));
}

// Follow / join / bare trigger -> help text.
{
  const { replies, post } = makeRuntime();
  post({ type: "follow", replyToken: "rt-3", source: { type: "user", userId: "U1" } });
  post({ type: "join", replyToken: "rt-4", source: { type: "group", groupId: "G1" } });
  post(groupText("?"));
  assert.equal(replies.length, 3);
  assert.ok(replies.every((r) => r.payload.messages[0].type === "text"));
  assert.match(replies[1].payload.messages[0].text, /@院內查藥 藥名/);
}

// Stickers, images and events without a reply token are ignored.
{
  const { replies, post } = makeRuntime();
  post(
    { type: "message", replyToken: "rt-5", source: { type: "user" }, message: { type: "sticker" } },
    { type: "unfollow", source: { type: "user" } }
  );
  assert.equal(replies.length, 0);
}

// Flex rejected by LINE -> the same reply token is used for a text fallback.
{
  const { replies, post } = makeRuntime({ flexStatus: 400 });
  post(userText("rosuvastatin"));
  assert.equal(replies.length, 2);
  assert.equal(replies[1].payload.replyToken, "rt-1");
  assert.equal(replies[1].payload.messages[0].type, "text");
  assert.match(replies[1].payload.messages[0].text, /【院內有此藥】\n・Rosuvastatin \(Crestor\) 冠脂妥 10mg\/tab（OROSU）/);
}

// Malformed webhook bodies don't throw.
{
  const { context } = makeRuntime();
  assert.equal(context.doPost({ postData: { contents: "not json" } }).text, "OK");
  assert.equal(context.doPost(undefined).text, "OK");
  assert.match(context.doGet().text, /running/);
}

console.log("linebot: all assertions passed");
