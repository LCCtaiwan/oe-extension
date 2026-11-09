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

function makeRuntime({ props: initialProps = {}, groq = () => ({ code: 200, content: '{"question":"Q?"}' }), prompts = PROMPTS, pageHtml = html } = {}) {
  const props = { ...initialProps };
  const cacheStore = {};
  const calls = { rxclass: [], groq: [], sheetReads: 0 };
  const response = (status, body) => ({ getResponseCode: () => status, getContentText: () => body });
  const sheet = (rows) => ({
    getDataRange: () => ({
      getDisplayValues: () => {
        if (rows === SHEET) calls.sheetReads += 1;
        return rows;
      },
    }),
  });
  const tabs = { 院內清單: sheet(SHEET) };
  if (prompts) tabs["自訂提示"] = sheet(prompts);
  const output = { calls: [] };
  const chain = new Proxy(output, {
    get(target, key) {
      if (key === "calls") return target.calls;
      if (key === "html") return target.html;
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
        get: (key) => (key in cacheStore ? cacheStore[key] : null),
        getAll: (keys) => Object.fromEntries(keys.filter((k) => k in cacheStore).map((k) => [k, cacheStore[k]])),
        putAll: (values) => Object.assign(cacheStore, values),
        remove: (key) => delete cacheStore[key],
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
    HtmlService: {
      createTemplateFromFile: (name) => {
        output.calls.push(["file", name]);
        return {
          evaluate() {
            assert.equal(typeof this.bootJson, "string", "template must receive escaped JSON");
            output.html = pageHtml.replace(/<\?!=\s*bootJson\s*\?>/g, () => this.bootJson);
            assert.doesNotMatch(output.html, /<\?/, "all scriptlets must be evaluated");
            return chain;
          },
        };
      },
    },
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

// Pulls window.OE_BOOT back out of a served page.
function bootOf(page) {
  const match = page.match(/<script>window\.OE_BOOT = ([\s\S]*?);<\/script>/);
  assert.ok(match, "OE_BOOT script missing");
  assert.doesNotMatch(match[1], /<\//, "embedded JSON must not close the script tag");
  return JSON.parse(match[1]);
}

// doGet serves Index with a phone viewport and the list written into the page.
{
  const { context, output } = makeRuntime();
  context.doGet({ parameter: { q: "冠脂妥" } });
  assert.deepEqual(output.calls[0], ["file", "Index"]);
  assert.ok(output.calls.some(([name, key, value]) => name === "addMetaTag" && key === "viewport" && /width=device-width/.test(value)));
  assert.ok(output.calls.some(([name, title]) => name === "setTitle" && title === "院內查藥"));
  const boot = bootOf(output.html);
  assert.equal(boot.formulary.items.length, 3);
  assert.equal(boot.q, "冠脂妥");
  assert.equal(boot.nhiUrl, "https://lcctaiwan.github.io/chemodrugstable-query/nhi/");
  // Code.gs and Index.html carry the same build id, so the page can spot a mix-up.
  const pageBuild = output.html.match(/window\.OE_PAGE_BUILD = "([0-9a-f]{7})"/)[1];
  assert.equal(boot.build, pageBuild);
  assert.doesNotMatch(output.html, /__OE_BUILD__/);
}

// Template injection survives statement formatting; it is not an exact-text replacement.
for (const statement of [
  "window.OE_BOOT=<?!= bootJson ?>;",
  "window.OE_BOOT =\n<?!= bootJson ?>;",
]) {
  const { context, output } = makeRuntime({
    pageHtml: html.replace("window.OE_BOOT = <?!= bootJson ?>;", () => statement),
  });
  context.doGet({ parameter: { q: "statin" } });
  const bootScript = [...output.html.matchAll(/<script>([\s\S]*?)<\/script>/g)][1][1];
  const pageContext = { window: {} };
  vm.runInNewContext(bootScript, pageContext);
  assert.equal(pageContext.window.OE_BOOT.q, "statin");
  assert.equal(pageContext.window.OE_BOOT.formulary.items.length, 3);
}

// With ACCESS_TOKEN: no list without the right k=; with it, k is handed to the page.
{
  const { context, output } = makeRuntime({ props: { ACCESS_TOKEN: "s3cret" } });
  context.doGet({ parameter: { q: "x" } });
  const locked = bootOf(output.html);
  assert.deepEqual({ needsToken: locked.needsToken, q: locked.q, items: locked.formulary }, { needsToken: true, q: "x", items: undefined });
  assert.match(locked.build, /^[0-9a-f]{7}$/);
  context.doGet({ parameter: { k: "s3cret" } });
  const boot = bootOf(output.html);
  assert.equal(boot.k, "s3cret");
  assert.equal(boot.formulary.count, 3);
}

// A sheet error is shown on the page instead of breaking it.
{
  const { context, output } = makeRuntime();
  context.SpreadsheetApp.getActiveSpreadsheet = () => null;
  context.doGet({ parameter: {} });
  assert.match(bootOf(output.html).error, /找不到試算表/);
}

// "</script>" in a drug name can't break out of the embedded JSON.
{
  const { context, output } = makeRuntime();
  SHEET.push(["OX", "Evil </script><script>alert(1)</script> 10mg", "", "", "", "", "", "", "O"]);
  try {
    context.doGet({ parameter: {} });
    assert.equal(bootOf(output.html).formulary.items[3].name, "Evil </script><script>alert(1)</script> 10mg");
  } finally {
    SHEET.pop();
  }
}

// The parsed list is cached; onEdit (any sheet edit) and a manual refresh re-read it.
{
  const { context, calls } = makeRuntime();
  context.getBootstrap("");
  context.getBootstrap("");
  context.doGet({ parameter: {} });
  assert.equal(calls.sheetReads, 1);
  context.onEdit();
  context.getBootstrap("");
  assert.equal(calls.sheetReads, 2);
  context.getBootstrap("", "", true);
  assert.equal(calls.sheetReads, 3);
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

// Cached misses must not hide an outage for every remaining RxClass term.
{
  const { context } = makeRuntime();
  context.lookupRxClass("sodium"); // cache an unknown-name result
  context.UrlFetchApp.fetchAll = (requests) => requests.map(() => ({
    getResponseCode: () => 503, getContentText: () => "unavailable",
  }));
  assert.throws(() => context.lookupRxClass("sodium bicarbonate"), /暫時連不上/);
}

// Malformed 200 responses are retried rather than cached as a six-hour miss.
{
  const { context, plain } = makeRuntime();
  const fetchAll = context.UrlFetchApp.fetchAll;
  context.UrlFetchApp.fetchAll = (requests) => requests.map(() => ({
    getResponseCode: () => 200, getContentText: () => "not JSON",
  }));
  assert.throws(() => context.lookupRxClass("Lipitor"), /暫時連不上/);
  context.UrlFetchApp.fetchAll = fetchAll;
  assert.equal(plain(context.lookupRxClass("Lipitor"))[0].ingredient, "atorvastatin");
}

// Chinese-heavy lists must fit CacheService's byte limit, not just JS string length.
{
  const { context, calls } = makeRuntime();
  const cache = context.CacheService.getScriptCache();
  const putAll = cache.putAll;
  cache.putAll = (values) => {
    for (const value of Object.values(values)) {
      assert.ok(Buffer.byteLength(value, "utf8") <= 100 * 1024, "cache value exceeds 100 KB");
    }
    putAll(values);
  };
  context.CacheService.getScriptCache = () => cache;
  const originalLength = SHEET.length;
  for (let i = 0; i < 600; i += 1) {
    SHEET.push(["X" + i, "Rosuvastatin " + "中文藥品".repeat(25), "", "", "", "", "C10AA07", "", "O"]);
  }
  try {
    context.getBootstrap("");
    context.getBootstrap("");
    assert.equal(calls.sheetReads, 1, "second request must use the chunked cache");
  } finally {
    SHEET.splice(originalLength);
  }
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
  assert.equal(html.split("<?!= bootJson ?>").length, 2, "exactly one boot template expression");
  assert.doesNotMatch(html, /<script[^>]+src=/, "HtmlService pages can't load local scripts");
  assert.doesNotMatch(html.replace("<?!= bootJson ?>", "null"), /<\?/, "only the boot scriptlet is allowed");
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.equal(scripts.length, 3, "startup check + OE_BOOT + formulary.js/page.js");
  assert.doesNotMatch(scripts[2], /[^\x00-\x7f]/, "inlined code is pure ASCII");
  scripts.forEach((source) => new vm.Script(source.replace("<?!= bootJson ?>", "null")));
  assert.match(html, /<base target="_top" \/>/);
  assert.match(html, /id="link-oe"/);
}

// Apps Script's HTML service strips "//" to the end of the line outside
// '...' / "..." strings (it doesn't know template literals). The page scripts
// must still compile after that, or the page dies with a SyntaxError.
{
  const stripLineComments = (code) => {
    let out = "";
    let quote = null;
    for (let i = 0; i < code.length; i += 1) {
      const c = code[i];
      if (quote) {
        out += c;
        if (c === "\\") {
          out += code[(i += 1)] ?? "";
        } else if (c === quote || c === "\n") {
          quote = null;
        }
      } else if (c === '"' || c === "'") {
        quote = c;
        out += c;
      } else if (c === "/" && code[i + 1] === "/") {
        while (i < code.length && code[i] !== "\n") i += 1;
        out += "\n";
      } else {
        out += c;
      }
    }
    return out;
  };
  for (const [, source] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
    new vm.Script(stripLineComments(source.replace("<?!= bootJson ?>", "null")));
  }
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

  // A selected paragraph lists every in-house drug it names.
  const passage = context.doGet({
    parameter: {
      api: "lookup",
      q: "High-intensity statins such as rosuvastatin or atorvastatin are recommended; dapagliflozin slows CKD progression.",
    },
  }).text;
  assert.match(passage, /^📋 文中的院內藥品（3）/);
  assert.match(passage, /▸ rosuvastatin\n・Rosuvastatin \(Crestor\)[^\n]*\n　OROSU/);
  assert.match(passage, /▸ atorvastatin\n・Atorvastatin/);
  assert.match(passage, /▸ dapagliflozin\n・Dapagliflozin/);
  assert.match(
    context.doGet({ parameter: { api: "lookup", q: "Finerenone may be added for residual albuminuria in these patients." } }).text,
    /^❌ 這段文字裡沒有院內品項的藥名/,
  );
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

// POST defaults to lookup: the two-action Shortcut sends one decoded Form field.
{
  const { context, calls } = makeRuntime({ props: { GROQ_API_KEY: "gsk_test" } });
  const post = context.doPost({ parameter: { q: "冠脂妥" } });
  assert.match(post.text, /院內有此藥/);
  assert.match(post.text, /OROSU/);
  assert.equal(post.text, context.doGet({ parameter: { api: "lookup", q: "冠脂妥" } }).text);
  assert.equal(calls.groq.length, 0, "default lookup must not spend AI quota");
  assert.equal(context.doPost().text, "請先選取或複製文字。");
  assert.equal(context.doPost({ parameter: {} }).text, "請先選取或複製文字。");
  assert.equal(context.doPost({ parameter: { q: "   " } }).text, "請先選取或複製文字。");
}

// Form data is already decoded by GAS. Preserve punctuation; clip before lookup.
{
  const { context } = makeRuntime();
  let received;
  context.lookupText_ = (query) => { received = query; return "result"; };
  const q = "中文藥名 + sodium & potassium = 50% / literal%20\n第二行";
  assert.equal(context.doPost({ parameter: { q } }).text, "result");
  assert.equal(received, q);
  context.doPost({ parameter: { q: "x".repeat(5000) } });
  assert.equal(received.length, 4000);
}

// POST supports explicit modes, but cannot bypass existing token validation.
{
  const { context, calls } = makeRuntime({ props: { ACCESS_TOKEN: "s3cret", GROQ_API_KEY: "gsk_test" } });
  assert.match(context.doPost({ parameter: { q: "冠脂妥" } }).text, /^⚠️ 連結缺少/);
  assert.match(context.doPost({ parameter: { q: "冠脂妥", k: "wrong" } }).text, /^⚠️ 連結缺少/);
  assert.equal(calls.sheetReads, 0, "refused requests must not read the sheet");
  assert.match(context.doPost({ parameter: { q: "冠脂妥", k: "s3cret" } }).text, /院內有此藥/);
  assert.equal(context.doPost({ parameter: { api: "pico", q: "statin CKD", k: "s3cret" } }).text, "Q?");
  assert.match(context.doPost({ parameter: { api: "unknown", q: "x", k: "s3cret" } }).text, /不認得的 api/);
}


console.log("gas.test.mjs passed");
