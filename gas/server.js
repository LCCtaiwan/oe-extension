// 院內查藥 · OE — Google Apps Script web app (phone version of the extension).
//
// Bound to the formulary Google Sheet. The page (Index.html)
// downloads the list once and matches on the phone with OEFormulary
// (src/formulary.js, which the build prepends to this file); this file only
// does what a phone page can't: read the sheet, call NLM RxClass without CORS,
// and call Groq with a key that never leaves the server.
//
// Script properties (專案設定 → 指令碼屬性):
//   GROQ_API_KEY     optional — turns on PICO / custom prompt / AI ATC guess
//   AI_DAILY_LIMIT   optional — Groq calls per day for everyone (default 300)
//   SHEET_NAME       optional — formulary tab (default: first tab)
//   SPREADSHEET_ID   optional — only if the script is not bound to the sheet
//   ACCESS_TOKEN     optional — required as ?k= on every call once set (needed
//                    when the deployment is open to 所有人 for the Shortcut)
//
// Custom prompt buttons come from a tab named 自訂提示 with header row
// 名稱 | 提示 (up to 6 rows), the phone equivalent of the extension's options.

/* global OEFormulary, SpreadsheetApp, UrlFetchApp, PropertiesService, CacheService,
   HtmlService, ContentService, LockService, Utilities, Session, ScriptApp */

var APP = {
  name: "院內查藥",
  groqModel: "llama-3.3-70b-versatile",
  groqUrl: "https://api.groq.com/openai/v1/chat/completions",
  promptsSheet: "自訂提示",
  maxPrompts: 6,
  maxText: 4000,
  aiDailyLimit: 300,
  rxclassCacheSeconds: 6 * 60 * 60,
};

// Same instructions as the Chrome extension (src/background.js).
var PICO_INSTRUCTION =
  'Rewrite my recall question as an EBM foreground question. Shift "what/which" to "what\'s the evidence for/why." ' +
  "Impose PICO (population, intervention/exposure, comparator, outcome) and pick the right question type " +
  "(therapy/diagnosis/prognosis). Require cited evidence, guideline comparison, and clinical implications--not just definitions.\n\n" +
  'Export as JSON:\n{"question":"$output"}';

var ATC_GUESS_INSTRUCTION =
  "Identify the medications named in the text below (generic or brand names, any language). For each, give its " +
  "generic name and its WHO ATC code at the most specific level you are confident of (prefer the 7-character code). " +
  "Ignore anything that is not a medication.\n\n" +
  'Export as JSON:\n{"drugs":[{"name":"empagliflozin","atc":"A10BK03"}]}\nIf there are none, export {"drugs":[]}.';

// ?api=lookup&q=… / ?api=pico&q=… answer in plain text for the iPhone
// Shortcut (shown as a pop-up over the current app); anything else is the page.
function doGet(e) {
  var params = (e && e.parameter) || {};
  if (params.api) {
    return ContentService.createTextOutput(handleApi_(params)).setMimeType(ContentService.MimeType.TEXT);
  }
  return HtmlService.createHtmlOutputFromFile("Index")
    .setTitle(APP.name)
    .addMetaTag("viewport", "width=device-width, initial-scale=1, viewport-fit=cover");
}

// ------------------------------------------------------------ access token

// Shortcuts can't sign in to Google, so the shortcut needs a deployment that
// anyone can reach. ACCESS_TOKEN (script property) then keeps the list to
// people who were given the link: every call must carry it as ?k=.
function checkToken_(token) {
  var expected = (PropertiesService.getScriptProperties().getProperty("ACCESS_TOKEN") || "").trim();
  if (expected && String(token || "").trim() !== expected) {
    throw new Error("連結缺少或帶錯存取碼（k=），請向管理者要新的連結");
  }
}

// --------------------------------------------------------------- text API

function handleApi_(params) {
  try {
    checkToken_(params.k);
    var query = clip_(params.q);
    if (!query) {
      return "請先選取或複製文字。";
    }
    if (params.api === "pico") {
      return rewriteText("pico", query, params.k).text;
    }
    if (params.api === "lookup") {
      return lookupText_(query);
    }
    return "不認得的 api：" + params.api;
  } catch (error) {
    return "⚠️ " + (error && error.message ? error.message : error);
  }
}

function itemLine_(item) {
  var parts = [];
  if (item.code) {
    parts.push(item.code);
  }
  if (item.form) {
    parts.push(OEFormulary.formLabel(item.form) || item.form);
  }
  if (item.nhiPrice && item.nhiPrice !== "0") {
    parts.push("健保 " + item.nhiPrice);
  }
  if (item.locations && item.locations.length) {
    parts.push(
      item.locations
        .map(function (loc) {
          return String(loc[0]).replace(/儲位$/, "") + " " + loc[1];
        })
        .join(" ")
    );
  }
  return "・" + item.name + (parts.length ? "\n　" + parts.join("｜") : "");
}

// The same lookup as the page (list -> RxClass), condensed for a pop-up.
function lookupText_(query) {
  var index = OEFormulary.createIndex(readFormulary_().items);
  var result = OEFormulary.lookup(index, query);
  var lines = [];
  var source = "";
  if (!result.direct.length && OEFormulary.rxclassTerms(query).length) {
    try {
      var rxclass = rxclassMatches_(query);
      if (rxclass.length) {
        var related = OEFormulary.lookupByIngredients(index, rxclass);
        result = { query: result.query, direct: [], sameIngredient: related.sameIngredient, classes: related.classes };
        var seen = {};
        source = rxclass
          .filter(function (m) {
            var key = m.ingredient + "|" + m.atcClass;
            return seen[key] ? false : (seen[key] = true);
          })
          .map(function (m) {
            return m.ingredient + " → " + m.atcClass;
          })
          .join("、");
      }
    } catch (_error) {
      source = "";
    }
  }
  var add = function (title, items, max) {
    lines.push("【" + title + "】");
    items.slice(0, max).forEach(function (item) {
      lines.push(itemLine_(item));
    });
    if (items.length > max) {
      lines.push("　…還有 " + (items.length - max) + " 項");
    }
  };
  if (result.direct.length) {
    add("✅ 院內有此藥", result.direct, 5);
  } else {
    lines.push("❌ 院內沒有符合的品項");
    if (source) {
      lines.push("RxClass：" + source);
    }
  }
  if (result.sameIngredient.length) {
    add(result.direct.length ? "同成分其他品項" : "院內同成分", result.sameIngredient, 4);
  }
  result.classes.slice(0, 2).forEach(function (group) {
    add("同機轉 " + group.atcClass, group.items, 4);
  });
  return lines.join("\n");
}

// ------------------------------------------------------------- page calls

// First call from the page. `knownFingerprint` is the list the phone already
// has; when unchanged the items are left out so the reply stays small.
function getBootstrap(knownFingerprint, token) {
  checkToken_(token);
  var parsed = readFormulary_();
  var fingerprint = OEFormulary.formularyFingerprint(parsed.items);
  var unchanged = knownFingerprint && knownFingerprint === fingerprint;
  var appUrl = "";
  try {
    appUrl = ScriptApp.getService().getUrl() || "";
  } catch (_error) {
    appUrl = "";
  }
  return {
    formulary: {
      items: unchanged ? null : parsed.items,
      count: parsed.items.length,
      withAtc: parsed.withAtc,
      missingColumns: parsed.missingColumns,
      fingerprint: fingerprint,
    },
    ai: Boolean(groqKey_()),
    prompts: readPrompts_().map(function (prompt) {
      return { name: prompt.name };
    }),
    appUrl: appUrl,
  };
}

// Drug names in `text` -> [{ ingredient, atcClass, className }] via NLM RxClass.
function lookupRxClass(text, token) {
  checkToken_(token);
  return rxclassMatches_(text);
}

function rxclassMatches_(text) {
  var terms = OEFormulary.rxclassTerms(clip_(text));
  if (terms.length === 0) {
    return [];
  }
  var cache = CacheService.getScriptCache();
  var keys = terms.map(function (term) {
    return "rx:" + term.toLowerCase();
  });
  var cached = cache.getAll(keys) || {};
  var missing = terms.filter(function (_term, i) {
    return cached[keys[i]] === undefined || cached[keys[i]] === null;
  });

  var fetched = {};
  if (missing.length > 0) {
    var responses = UrlFetchApp.fetchAll(
      missing.map(function (term) {
        return {
          url:
            "https://rxnav.nlm.nih.gov/REST/rxclass/class/byDrugName.json?relaSource=ATC&drugName=" +
            encodeURIComponent(term),
          muteHttpExceptions: true,
        };
      })
    );
    var failures = 0;
    var toCache = {};
    responses.forEach(function (response, i) {
      var code = response.getResponseCode();
      var matches = [];
      if (code === 200) {
        try {
          matches = OEFormulary.parseRxClassResponse(JSON.parse(response.getContentText()));
        } catch (_error) {
          matches = [];
        }
      } else if (code !== 404) {
        failures += 1; // 404 = name unknown to RxNav, a real answer
        return;
      }
      fetched["rx:" + missing[i].toLowerCase()] = matches;
      toCache["rx:" + missing[i].toLowerCase()] = JSON.stringify(matches);
    });
    if (failures === terms.length) {
      throw new Error("RxClass 暫時連不上");
    }
    if (Object.keys(toCache).length > 0) {
      cache.putAll(toCache, APP.rxclassCacheSeconds);
    }
  }

  var perTerm = terms.map(function (term, i) {
    var key = keys[i];
    var matches = fetched[key];
    if (!matches && cached[key]) {
      try {
        matches = JSON.parse(cached[key]);
      } catch (_error) {
        matches = [];
      }
    }
    return { term: term, matches: matches || [] };
  });
  // A resolved short phrase ("sodium bicarbonate") wins over its single words.
  var phraseHit = perTerm[0].term.indexOf(" ") !== -1 && perTerm[0].matches.length > 0;
  return (phraseHit ? perTerm.slice(0, 1) : perTerm).reduce(function (all, entry) {
    return all.concat(
      entry.matches.map(function (match) {
        return {
          ingredient: match.ingredient,
          atcClass: match.atcClass,
          className: match.className,
          term: entry.term,
        };
      })
    );
  }, []);
}

// Last resort when neither the list nor RxClass knows the name.
function guessAtc(text, token) {
  checkToken_(token);
  var content = callGroq_(ATC_GUESS_INSTRUCTION + "\n\n+++text+++\n" + clip_(text).slice(0, 2000), true);
  var parsed;
  try {
    parsed = JSON.parse(content);
  } catch (_error) {
    return [];
  }
  var drugs = parsed && Array.isArray(parsed.drugs) ? parsed.drugs : [];
  return drugs
    .map(function (drug) {
      return {
        name: drug && typeof drug.name === "string" ? drug.name.trim().slice(0, 80) : "",
        atc: OEFormulary.normalizeAtc(drug && drug.atc),
      };
    })
    .filter(function (drug) {
      return drug.name && drug.atc;
    })
    .slice(0, 5);
}

// kind: "pico", or the index of a 自訂提示 row. The page sends the index, not
// the prompt, so the server key only runs the prompts set in the sheet.
function rewriteText(kind, text, token) {
  checkToken_(token);
  var selection = clip_(text);
  if (!selection) {
    throw new Error("請先輸入文字");
  }
  if (kind === "pico") {
    var content = callGroq_(PICO_INSTRUCTION + "\n\n+++user selection+++\n" + selection, true);
    return { name: "PICO", text: extractPicoQuestion_(content) };
  }
  var prompt = readPrompts_()[Number(kind)];
  if (!prompt) {
    throw new Error("找不到這個自訂提示，請重新整理頁面");
  }
  return { name: prompt.name, text: callGroq_(selection + "\n\n" + prompt.prompt, false).trim() };
}

// ----------------------------------------------------------------- sheet

function spreadsheet_() {
  var id = PropertiesService.getScriptProperties().getProperty("SPREADSHEET_ID");
  var spreadsheet = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) {
    throw new Error("找不到試算表：請把程式放在院內清單試算表的 Apps Script 裡，或設定 SPREADSHEET_ID");
  }
  return spreadsheet;
}

function readFormulary_() {
  var spreadsheet = spreadsheet_();
  var sheetName = PropertiesService.getScriptProperties().getProperty("SHEET_NAME");
  var sheet = sheetName ? spreadsheet.getSheetByName(sheetName) : spreadsheet.getSheets()[0];
  if (!sheet) {
    throw new Error("找不到工作表 " + sheetName);
  }
  return OEFormulary.rowsToFormulary(sheet.getDataRange().getDisplayValues());
}

function readPrompts_() {
  var sheet = spreadsheet_().getSheetByName(APP.promptsSheet);
  if (!sheet) {
    return [];
  }
  var rows = sheet.getDataRange().getDisplayValues();
  var header = (rows[0] || []).map(function (cell) {
    return String(cell).replace(/\s+/g, "");
  });
  var nameCol = header.indexOf("名稱");
  var promptCol = header.indexOf("提示");
  if (nameCol === -1 || promptCol === -1) {
    return [];
  }
  return rows
    .slice(1)
    .map(function (row) {
      return { name: String(row[nameCol] || "").trim(), prompt: String(row[promptCol] || "").trim() };
    })
    .filter(function (prompt) {
      return prompt.name && prompt.prompt;
    })
    .slice(0, APP.maxPrompts);
}

// ------------------------------------------------------------------ Groq

function groqKey_() {
  return (PropertiesService.getScriptProperties().getProperty("GROQ_API_KEY") || "").trim();
}

// One shared daily budget, since everyone uses the owner's key.
function takeAiQuota_() {
  var props = PropertiesService.getScriptProperties();
  var limit = parseInt(props.getProperty("AI_DAILY_LIMIT"), 10);
  if (!(limit >= 0)) {
    limit = APP.aiDailyLimit;
  }
  var today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd");
  var lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    var usage = {};
    try {
      usage = JSON.parse(props.getProperty("AI_USAGE") || "{}");
    } catch (_error) {
      usage = {};
    }
    var count = usage.date === today ? usage.count || 0 : 0;
    if (count >= limit) {
      throw new Error("今天的 AI 改寫額度（" + limit + " 次）已用完，明天再試");
    }
    props.setProperty("AI_USAGE", JSON.stringify({ date: today, count: count + 1 }));
  } finally {
    lock.releaseLock();
  }
}

function callGroq_(prompt, jsonMode) {
  var key = groqKey_();
  if (!key) {
    throw new Error("尚未設定 GROQ_API_KEY，AI 功能未開啟");
  }
  takeAiQuota_();
  var body = {
    model: APP.groqModel,
    messages: [{ role: "user", content: prompt }],
    temperature: 0.2,
  };
  if (jsonMode) {
    body.response_format = { type: "json_object" };
  }
  var response = UrlFetchApp.fetch(APP.groqUrl, {
    method: "post",
    contentType: "application/json",
    headers: { Authorization: "Bearer " + key },
    payload: JSON.stringify(body),
    muteHttpExceptions: true,
  });
  var data = {};
  try {
    data = JSON.parse(response.getContentText() || "{}");
  } catch (_error) {
    data = {};
  }
  var code = response.getResponseCode();
  if (code !== 200) {
    var message = data && data.error && data.error.message;
    throw new Error("Groq 錯誤（HTTP " + code + "）" + (message ? "：" + message : ""));
  }
  var content =
    data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  content = typeof content === "string" ? content.trim() : "";
  if (!content) {
    throw new Error("Groq 沒有回傳內容");
  }
  return content;
}

function extractPicoQuestion_(content) {
  var trimmed = String(content || "").trim();
  try {
    var parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed.question === "string" && parsed.question.trim()) {
      return parsed.question.trim();
    }
  } catch (_error) {
    var match = trimmed.match(/"question"\s*:\s*"((?:\\.|[^"\\])*)"/);
    if (match) {
      try {
        var question = JSON.parse('"' + match[1] + '"').trim();
        if (question) {
          return question;
        }
      } catch (_ignored) {
        // fall through to the raw text
      }
    }
  }
  return trimmed;
}

function clip_(text) {
  return String(text || "").trim().slice(0, APP.maxText);
}

// Run once from the Apps Script editor to check the sheet and settings.
function testSetup() {
  var parsed = readFormulary_();
  console.log("院內清單：" + parsed.items.length + " 項（" + parsed.withAtc + " 項有 ATC 碼）");
  if (parsed.missingColumns.length) {
    console.log("沒有這些欄位（可省略）：" + parsed.missingColumns.join("、"));
  }
  var index = OEFormulary.createIndex(parsed.items);
  var sample = OEFormulary.lookup(index, "rosuvastatin");
  console.log("rosuvastatin → 院內 " + sample.direct.length + " 項");
  console.log("自訂提示：" + (readPrompts_().map(function (p) { return p.name; }).join("、") || "（無）"));
  console.log("AI（Groq）：" + (groqKey_() ? "已設定" : "未設定"));
}
