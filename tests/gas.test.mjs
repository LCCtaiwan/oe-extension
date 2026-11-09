import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = fileURLToPath(new URL("..", import.meta.url));

// The committed Code.gs / Index.html must match their sources.
execFileSync(process.execPath, ["scripts/build-gas.mjs", "--check"], { cwd: root, stdio: "inherit" });

const code = readFileSync(new URL("../gas/Code.gs", import.meta.url), "utf8");
const html = readFileSync(new URL("../gas/Index.html", import.meta.url), "utf8");

const SHEET = [
  ["批價碼", "藥名", "P1儲位", "藥庫", "健保價", "自費價", "ATC碼", "藥理代碼", "劑型"],
  ["OROSU", "Rosuvastatin (Crestor) 冠脂妥 10mg/tab", "A89", "A151", "10.3", "12", "C10AA07", "DN203", "O"],
  ["OATOR40", "Atorvastatin (Tulip) 妥寧 40 mg/tab", "A84", "A091", "16.6", "20", "C10AA05", "DN201", "O"],
  ["ODAPA", "Dapagliflozin (Forxiga) 福適佳 10mg/tab", "A26", "", "25.4", "30", "A10BK01", "GE301", "O"],
];
const PROMPTS = [
  ["名稱", "提示"],
  ["Dx", "List the differential diagnosis."],
  ["", "row without a name is skipped"],
  ["Guideline", "Which guidelines cover this?"],
];
const RX = { lipitor: [["atorvastatin", "C10AA", "HMG CoA reductase inhibitors"]] };

function makeRuntime({ props: initialProps = {}, groq = () => ({ code: 200, content: '{"question":"Q?"}' }), prompts = PROMPTS } = {}) {
  const props = { ...initialProps };
  const cacheStore = {};
  const calls = { rxclass: [], groq: [] };
  const response = (status, body) => ({ getResponseCode: () => status, getContentText: () => body });
  const sheet = (rows) => ({ getDataRange: () => ({ getDisplayValues: () => rows }) });
  const tabs = { 院內清單: sheet(SHEET) };
  if (prompts) tabs["自訂提示"] = sheet(prompts);
  const output = { calls: [] };
  const chain = new Proxy(output, {
    get(target, key) {
      if (key === "calls") return target.calls;
      return (...args) => {
        target.calls.push([key, ...args]);
        return chain;
      };
    },
  });

  const context = {
    console: { log() {}, warn() {}, error() {} },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (key) => (key in props ? props[key] : null),
        setProperty: (key, value) => {
          props[key] = String(value);
        },
      }),
    },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ({
        getSheets: () => [tabs["院內清單"], tabs["自訂提示"]].filter(Boolean),
        getSheetByName: (name) => tabs[name] || null,
      }),
    },
    CacheService: {
      getScriptCache: () => ({
        getAll: (keys) => Object.fromEntries(keys.filter((k) => k in cacheStore).map((k) => [k, cacheStore[k]])),
        putAll: (values) => Object.assign(cacheStore, values),
      }),
    },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Utilities: { formatDate: () => "2026-11-09" },
    Session: { getScriptTimeZone: () => "Asia/Taipei" },
    ScriptApp: { getService: () => ({ getUrl: () => "https://script.google.com/macros/s/ID/exec" }) },
    ContentService: {
      MimeType: { TEXT: "text/plain" },
      createTextOutput: (text) => ({ text, setMimeType() { return this; } }),
    },
    HtmlService: { createHtmlOutputFromFile: (name) => (output.calls.push(["file", name]), chain) },
    UrlFetchApp: {
      fetchAll: (requests) =>
        requests.map((request) => {
          const name = decodeURIComponent(request.url.split("drugName=")[1]).toLowerCase();
          calls.rxclass.push(name);
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
            }),
          );
        }),
      fetch: (url, options) => {
        const payload = JSON.parse(options.payload);
        calls.groq.push({ url, auth: options.headers.Authorization, payload });
        const reply = groq(payload);
        return response(
          reply.code,
          JSON.stringify(reply.code === 200 ? { choices: [{ message: { content: reply.content } }] } : { error: { message: "bad key" } }),
        );
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(code, context);
  // vm objects come from another realm; round-trip so deepEqual compares plain data.
  const plain = (value) => JSON.parse(JSON.stringify(value));
  return { context, props, calls, output, plain };
}

// doGet serves Index with a phone viewport.
{
  const { context, output } = makeRuntime();
  context.doGet({ parameter: {} });
  assert.deepEqual(output.calls[0], ["file", "Index"]);
  assert.ok(output.calls.some(([name, key, value]) => name === "addMetaTag" && key === "viewport" && /width=device-width/.test(value)));
  assert.ok(output.calls.some(([name, title]) => name === "setTitle" && title === "院內查藥"));
}

// Bootstrap: list, prompt names only (never the prompt text), AI off without a key.
{
  const { context, plain } = makeRuntime();
  const boot = plain(context.getBootstrap(""));
  assert.equal(boot.formulary.count, 3);
  assert.equal(boot.formulary.items.length, 3);
  assert.equal(boot.formulary.items[0].code, "OROSU");
  assert.equal(boot.ai, false);
  assert.deepEqual(boot.prompts, [{ name: "Dx" }, { name: "Guideline" }]);
  assert.equal(boot.appUrl, "https://script.google.com/macros/s/ID/exec");
  assert.equal(boot.nhiUrl, "https://lcctaiwan.github.io/chemodrugstable-query/nhi/");

  // Same fingerprint as the phone's copy -> items left out.
  const again = plain(context.getBootstrap(boot.formulary.fingerprint));
  assert.equal(again.formulary.items, null);
  assert.equal(again.formulary.count, 3);
}

// No 自訂提示 tab -> no custom prompts; AI on with a key.
{
  const { context, plain } = makeRuntime({ prompts: null, props: { GROQ_API_KEY: "gsk_test" } });
  const boot = plain(context.getBootstrap(""));
  assert.deepEqual(boot.prompts, []);
  assert.equal(boot.ai, true);
}

// NHI_URL: "-" hides the 健保 links, an https URL replaces the default.
{
  assert.equal(makeRuntime({ props: { NHI_URL: "-" } }).context.getBootstrap("").nhiUrl, "");
  assert.equal(makeRuntime({ props: { NHI_URL: "https://x.example/nhi/" } }).context.getBootstrap("").nhiUrl, "https://x.example/nhi/");
  assert.equal(makeRuntime({ props: { NHI_URL: "javascript:alert(1)" } }).context.getBootstrap("").nhiUrl, "https://lcctaiwan.github.io/chemodrugstable-query/nhi/");
}

// RxClass: brand name resolves, results are cached per term.
{
  const { context, calls, plain } = makeRuntime();
  const matches = plain(context.lookupRxClass("Lipitor"));
  assert.deepEqual(matches, [
    { ingredient: "atorvastatin", atcClass: "C10AA", className: "HMG CoA reductase inhibitors", term: "Lipitor" },
  ]);
  assert.equal(calls.rxclass.length, 1);
  context.lookupRxClass("Lipitor");
  assert.equal(calls.rxclass.length, 1, "second lookup should come from the cache");
  assert.deepEqual(plain(context.lookupRxClass("冠脂妥")), [], "Chinese text sends nothing to RxClass");
  assert.deepEqual(plain(context.lookupRxClass("zzzunknowndrug")), []);
}

// AI is refused without a key.
{
  const { context } = makeRuntime();
  assert.throws(() => context.rewriteText("pico", "statin in CKD"), /GROQ_API_KEY/);
}

// PICO and custom prompts go through Groq with the server-side key.
{
  const { context, calls, plain } = makeRuntime({
    props: { GROQ_API_KEY: "gsk_test" },
    groq: (payload) =>
      payload.response_format
        ? { code: 200, content: '{"question":"In adults with CKD, does a statin reduce MACE?"}' }
        : { code: 200, content: "  1. CKD-MBD\n2. Gout  " },
  });
  const pico = plain(context.rewriteText("pico", "statin CKD"));
  assert.deepEqual(pico, { name: "PICO", text: "In adults with CKD, does a statin reduce MACE?" });
  assert.equal(calls.groq[0].auth, "Bearer gsk_test");
  assert.equal(calls.groq[0].payload.model, "llama-3.3-70b-versatile");
  assert.match(calls.groq[0].payload.messages[0].content, /\+\+\+user selection\+\+\+\nstatin CKD$/);

  const custom = plain(context.rewriteText(1, "hyperuricemia"));
  assert.deepEqual(custom, { name: "Guideline", text: "1. CKD-MBD\n2. Gout" });
  assert.equal(calls.groq[1].payload.messages[0].content, "hyperuricemia\n\nWhich guidelines cover this?");
  assert.equal(calls.groq[1].payload.response_format, undefined);

  assert.throws(() => context.rewriteText(9, "x"), /找不到這個自訂提示/);
  assert.throws(() => context.rewriteText("pico", "   "), /請先輸入文字/);
}

// Daily limit is shared and enforced.
{
  const { context, props } = makeRuntime({ props: { GROQ_API_KEY: "gsk_test", AI_DAILY_LIMIT: "2" } });
  context.rewriteText("pico", "a");
  context.rewriteText("pico", "b");
  assert.throws(() => context.rewriteText("pico", "c"), /額度（2 次）已用完/);
  assert.deepEqual(JSON.parse(props.AI_USAGE), { date: "2026-11-09", count: 2 });
}

// A new day resets the count.
{
  const { context, props } = makeRuntime({
    props: { GROQ_API_KEY: "gsk_test", AI_DAILY_LIMIT: "1", AI_USAGE: '{"date":"2026-11-08","count":1}' },
  });
  context.rewriteText("pico", "a");
  assert.deepEqual(JSON.parse(props.AI_USAGE), { date: "2026-11-09", count: 1 });
}

// Groq errors surface with the HTTP code.
{
  const { context } = makeRuntime({ props: { GROQ_API_KEY: "gsk_bad" }, groq: () => ({ code: 401 }) });
  assert.throws(() => context.rewriteText("pico", "a"), /HTTP 401.*bad key/);
}

// AI ATC guess is normalised and filtered.
{
  const { context, plain } = makeRuntime({
    props: { GROQ_API_KEY: "gsk_test" },
    groq: () => ({ code: 200, content: '{"drugs":[{"name":"ertugliflozin","atc":"a10bk04"},{"name":"x","atc":"nope"}]}' }),
  });
  assert.deepEqual(plain(context.guessAtc("Steglatro")), [{ name: "ertugliflozin", atc: "A10BK04" }]);
}

// Index.html: everything inlined, both scripts compile, no leftover markers.
{
  assert.doesNotMatch(html, /<!-- @(style|script) -->/);
  assert.doesNotMatch(html, /<script[^>]+src=/, "HtmlService pages can't load local scripts");
  assert.doesNotMatch(html, /<\?/, "no Apps Script scriptlets expected");
  const scripts = [...html.matchAll(/<script>\n([\s\S]*?)\n<\/script>/g)].map((m) => m[1]);
  assert.equal(scripts.length, 2);
  scripts.forEach((source) => new vm.Script(source));
  assert.match(html, /<base target="_top" \/>/);
  assert.match(html, /id="link-oe"/);
}

// Text API for the iPhone Shortcut pop-up.
{
  const { context } = makeRuntime();
  const hit = context.doGet({ parameter: { api: "lookup", q: "冠脂妥" } }).text;
  assert.match(hit, /^【✅ 院內有此藥】\n・Rosuvastatin \(Crestor\)/);
  assert.match(hit, /OROSU｜口服｜健保 10.3｜P1 A89 藥庫 A151/);
  assert.match(hit, /【同機轉 C10AA】\n・Atorvastatin/);

  const viaRx = context.doGet({ parameter: { api: "lookup", q: "Lipitor" } }).text;
  assert.match(viaRx, /❌ 院內沒有符合的品項\nRxClass：atorvastatin → C10AA/);
  assert.match(viaRx, /【院內同成分】\n・Atorvastatin \(Tulip\)/);

  assert.equal(context.doGet({ parameter: { api: "lookup", q: " " } }).text, "請先選取或複製文字。");
  assert.match(context.doGet({ parameter: { api: "pico", q: "x" } }).text, /^⚠️ 尚未設定 GROQ_API_KEY/);
}

{
  const { context } = makeRuntime({ props: { GROQ_API_KEY: "gsk_test" } });
  assert.equal(context.doGet({ parameter: { api: "pico", q: "statin CKD" } }).text, "Q?");
}

// ACCESS_TOKEN: every entry point requires ?k= once it is set.
{
  const { context, plain } = makeRuntime({ props: { ACCESS_TOKEN: "s3cret", GROQ_API_KEY: "gsk_test" } });
  assert.match(context.doGet({ parameter: { api: "lookup", q: "冠脂妥" } }).text, /^⚠️ 連結缺少或帶錯存取碼/);
  assert.match(context.doGet({ parameter: { api: "lookup", q: "冠脂妥", k: "nope" } }).text, /^⚠️ 連結缺少/);
  assert.match(context.doGet({ parameter: { api: "lookup", q: "冠脂妥", k: "s3cret" } }).text, /院內有此藥/);
  assert.throws(() => context.getBootstrap(""), /存取碼/);
  assert.equal(plain(context.getBootstrap("", "s3cret")).formulary.count, 3);
  assert.throws(() => context.lookupRxClass("Lipitor", "x"), /存取碼/);
  assert.throws(() => context.guessAtc("Lipitor"), /存取碼/);
  assert.throws(() => context.rewriteText("pico", "a", "x"), /存取碼/);
  assert.equal(plain(context.rewriteText("pico", "a", "s3cret")).text, "Q?");
}

console.log("gas.test.mjs passed");
