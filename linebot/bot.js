// 院內查藥 LINE Bot — Google Apps Script, bound to the formulary Google Sheet.
//
// Reads the sheet directly (the same single source the web app and the Chrome
// extension sync from), matches with OEFormulary (src/formulary.js, which the
// build prepends to this file), and replies with a Flex carousel. When nothing
// matches by name, NLM RxClass supplies the ATC class, fetched server-side.
//
// Script properties (專案設定 → 指令碼屬性):
//   LINE_CHANNEL_ACCESS_TOKEN  required — Messaging API channel access token
//   SHEET_NAME                 optional — tab to read (default: first tab)
//   SPREADSHEET_ID             optional — only if the script is not bound to the sheet
//
// Note: Apps Script cannot read request headers, so the X-Line-Signature can't
// be verified. A forged webhook call still can't extract data: replies go out
// only through LINE's reply API with a reply token that LINE itself issued.

/* global OEFormulary, SpreadsheetApp, UrlFetchApp, PropertiesService, ContentService */

var BOT = {
  name: "院內查藥",
  // Group/room messages are answered only when the bot is @mentioned or the
  // text starts with one of these.
  triggers: ["/院內", "院內", "？", "?"],
  helpWords: ["help", "說明", "使用說明", "幫助", "?", "？"],
  maxItemsPerBubble: 8,
  maxClassBubbles: 4,
  brand: "#f3602d",
  brandDark: "#d9481a",
  muted: "#5f646b",
  surface: "#f4f4f5",
  formLabels: { O: "口服", I: "注射", E: "外用" },
};

function doGet() {
  return ContentService.createTextOutput(BOT.name + " LINE Bot is running.");
}

function doPost(e) {
  var body = {};
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || "{}");
  } catch (_error) {
    body = {};
  }
  (body.events || []).forEach(function (event) {
    try {
      handleEvent_(event);
    } catch (error) {
      console.error("handleEvent failed: " + (error && error.stack ? error.stack : error));
    }
  });
  return ContentService.createTextOutput("OK");
}

// ------------------------------------------------------------------ events

function handleEvent_(event) {
  if (!event || !event.replyToken) {
    return;
  }

  if (event.type === "follow" || event.type === "join") {
    reply_(event.replyToken, [textMessage_(helpText_(event.type === "join"))]);
    return;
  }

  if (event.type !== "message" || !event.message || event.message.type !== "text") {
    return;
  }

  var query = extractQuery_(event);
  if (query === null) {
    return; // group chatter not addressed to the bot
  }
  if (!query || BOT.helpWords.indexOf(query.toLowerCase()) !== -1) {
    reply_(event.replyToken, [textMessage_(helpText_(isGroup_(event)))]);
    return;
  }

  var outcome = resolve_(query);
  reply_(event.replyToken, [buildFlex_(query, outcome)], textMessage_(buildPlainText_(query, outcome)));
}

function isGroup_(event) {
  var type = event.source && event.source.type;
  return type === "group" || type === "room";
}

// Returns the drug query, "" for a bare trigger/mention (→ help), or null when
// a group message isn't addressed to the bot.
function extractQuery_(event) {
  var text = String(event.message.text || "");
  var mention = event.message.mention;
  var selfSpans = ((mention && mention.mentionees) || []).filter(function (m) {
    return m && m.isSelf === true;
  });

  if (selfSpans.length > 0) {
    // Cut the @mentions out, last first so earlier indexes stay valid.
    selfSpans
      .sort(function (a, b) {
        return b.index - a.index;
      })
      .forEach(function (m) {
        text = text.slice(0, m.index) + " " + text.slice(m.index + m.length);
      });
    return stripTrigger_(text.replace(/\s+/g, " ").trim()).text;
  }

  var stripped = stripTrigger_(text.trim());
  if (isGroup_(event) && !stripped.triggered) {
    return null;
  }
  return stripped.text;
}

function stripTrigger_(text) {
  for (var i = 0; i < BOT.triggers.length; i += 1) {
    var trigger = BOT.triggers[i];
    if (text === trigger) {
      return { triggered: true, text: "" };
    }
    var isSymbol = trigger === "?" || trigger === "？";
    if (text.indexOf(trigger) === 0 && (isSymbol || /\s/.test(text.charAt(trigger.length)))) {
      return { triggered: true, text: text.slice(trigger.length).trim() };
    }
  }
  return { triggered: false, text: text };
}

function helpText_(inGroup) {
  var lines = [
    "💊 " + BOT.name,
    "傳藥名給我（學名、商品名、中文名或批價碼都可以），我會回覆：",
    "・院內有沒有這個藥（劑型、價格、儲位）",
    "・同成分的其他品項",
    "・同機轉（ATC 前 5 碼相同）的院內品項",
    "院內清單比對不到時，會查 NLM RxClass 找出 ATC 類別。",
    "",
    "例：rosuvastatin、冠脂妥、Lipitor、OATOR40",
  ];
  lines.push(
    "",
    inGroup
      ? "在群組裡請標記我：@" + BOT.name + " 藥名，或輸入「? 藥名」。"
      : "在群組裡使用時，請標記我或輸入「? 藥名」。",
    "⚠️ 請勿傳送含病人資料的內容。"
  );
  return lines.join("\n");
}

// ------------------------------------------------------------------ lookup

function loadIndex_() {
  var props = PropertiesService.getScriptProperties();
  var spreadsheetId = props.getProperty("SPREADSHEET_ID");
  var spreadsheet = spreadsheetId
    ? SpreadsheetApp.openById(spreadsheetId)
    : SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) {
    throw new Error("找不到試算表：請把程式放在試算表的 Apps Script 裡，或設定 SPREADSHEET_ID");
  }
  var sheetName = props.getProperty("SHEET_NAME");
  var sheet = sheetName ? spreadsheet.getSheetByName(sheetName) : spreadsheet.getSheets()[0];
  if (!sheet) {
    throw new Error("找不到工作表 " + sheetName);
  }
  var parsed = OEFormulary.rowsToFormulary(sheet.getDataRange().getDisplayValues());
  return OEFormulary.createIndex(parsed.items);
}

function fetchRxClass_(text) {
  var terms = OEFormulary.rxclassTerms(text);
  if (terms.length === 0) {
    return [];
  }
  var responses = UrlFetchApp.fetchAll(
    terms.map(function (term) {
      return {
        url:
          "https://rxnav.nlm.nih.gov/REST/rxclass/class/byDrugName.json?relaSource=ATC&drugName=" +
          encodeURIComponent(term),
        muteHttpExceptions: true,
      };
    })
  );
  var perTerm = responses.map(function (response, i) {
    var matches = [];
    if (response.getResponseCode() === 200) {
      try {
        matches = OEFormulary.parseRxClassResponse(JSON.parse(response.getContentText()));
      } catch (_error) {
        matches = [];
      }
    }
    return { term: terms[i], matches: matches };
  });
  // A resolved short phrase ("sodium bicarbonate") wins over its single words.
  var phraseHit = perTerm[0].term.indexOf(" ") !== -1 && perTerm[0].matches.length > 0;
  return (phraseHit ? perTerm.slice(0, 1) : perTerm).reduce(function (all, entry) {
    return all.concat(entry.matches);
  }, []);
}

function resolve_(query) {
  var index = loadIndex_();
  var local = OEFormulary.lookup(index, query);
  if (local.direct.length > 0) {
    return { result: local, source: "formulary" };
  }

  try {
    var rxclass = fetchRxClass_(query);
    if (rxclass.length > 0) {
      var related = OEFormulary.lookupByIngredients(index, rxclass);
      return {
        result: {
          query: local.query,
          direct: [],
          sameIngredient: related.sameIngredient,
          classes: related.classes,
        },
        source: "rxclass",
        rxclass: rxclass,
        classNames: related.classNames,
      };
    }
    return { result: local, source: "none" };
  } catch (error) {
    return { result: local, source: "none", rxclassError: String(error && error.message ? error.message : error) };
  }
}

// ----------------------------------------------------------------- replies

function truncate_(text, max) {
  text = String(text || "");
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

function metaLine_(item) {
  var parts = [];
  if (item.atc) {
    parts.push("ATC " + item.atc);
  }
  if (item.form) {
    parts.push(BOT.formLabels[item.form] || item.form);
  }
  var prices = [];
  if (item.nhiPrice && item.nhiPrice !== "0") {
    prices.push("健保 " + item.nhiPrice);
  }
  if (item.selfPrice && item.selfPrice !== "0") {
    prices.push("自費 " + item.selfPrice);
  }
  if (prices.length) {
    parts.push(prices.join(" · "));
  }
  if (item.locations && item.locations.length) {
    parts.push(
      item.locations
        .map(function (loc) {
          return String(loc[0]).replace(/儲位$/, "") + " " + loc[1];
        })
        .join(" · ")
    );
  }
  return parts.join("｜");
}

function itemBox_(item) {
  var contents = [
    { type: "text", text: truncate_(item.name, 120), weight: "bold", size: "sm", wrap: true },
  ];
  var meta = metaLine_(item);
  if (meta) {
    contents.push({ type: "text", text: truncate_(meta, 160), size: "xs", color: BOT.muted, wrap: true });
  }
  if (item.code) {
    contents.push({
      type: "text",
      text: "批價碼 " + item.code + "　📋 點我複製",
      size: "xs",
      color: BOT.brandDark,
      weight: "bold",
      action: { type: "clipboard", label: "複製批價碼", clipboardText: item.code },
    });
  }
  return {
    type: "box",
    layout: "vertical",
    spacing: "xs",
    paddingAll: "8px",
    cornerRadius: "6px",
    backgroundColor: BOT.surface,
    contents: contents,
  };
}

function noteText_(text, color) {
  return { type: "text", text: truncate_(text, 300), size: "xs", color: color || BOT.muted, wrap: true };
}

function bubble_(title, subtitle, bodyContents, footer) {
  var header = [{ type: "text", text: truncate_(title, 60), weight: "bold", color: "#ffffff", size: "md", wrap: true }];
  if (subtitle) {
    header.push({ type: "text", text: truncate_(subtitle, 80), color: "#ffe8de", size: "xs", wrap: true });
  }
  var bubble = {
    type: "bubble",
    size: "mega",
    header: { type: "box", layout: "vertical", paddingAll: "12px", backgroundColor: BOT.brand, contents: header },
    body: { type: "box", layout: "vertical", spacing: "sm", contents: bodyContents },
  };
  if (footer) {
    bubble.footer = footer;
  }
  return bubble;
}

function listContents_(items, notes) {
  var contents = (notes || []).slice();
  items.slice(0, BOT.maxItemsPerBubble).forEach(function (item) {
    contents.push(itemBox_(item));
  });
  if (items.length > BOT.maxItemsPerBubble) {
    contents.push(noteText_("還有 " + (items.length - BOT.maxItemsPerBubble) + " 項，請用更精確的名稱查詢。"));
  }
  return contents;
}

function linksFooter_(query) {
  var q = encodeURIComponent(truncate_(query, 200));
  var link = function (label, uri) {
    return { type: "button", style: "link", height: "sm", action: { type: "uri", label: label, uri: uri } };
  };
  return {
    type: "box",
    layout: "horizontal",
    spacing: "none",
    contents: [
      link("OpenEvidence", "https://www.openevidence.com/ask?query=" + q + "&configName=prod&attachments=%5B%5D"),
      link("UpToDate", "https://www.uptodate.com/contents/search?search=" + q),
      link("PubMed", "https://pubmed.ncbi.nlm.nih.gov/?term=" + q),
    ],
  };
}

function rxclassLine_(outcome) {
  var seen = {};
  return (outcome.rxclass || [])
    .filter(function (m) {
      var key = m.ingredient + "|" + m.atcClass;
      if (seen[key]) {
        return false;
      }
      seen[key] = true;
      return true;
    })
    .map(function (m) {
      return m.ingredient + " → ATC " + m.atcClass + (m.className ? " " + m.className : "");
    })
    .join("、");
}

function buildFlex_(query, outcome) {
  var result = outcome.result;
  var shortQuery = truncate_(query, 40);
  var bubbles = [];
  var footer = linksFooter_(query);

  if (result.direct.length > 0) {
    bubbles.push(bubble_("院內有此藥（" + result.direct.length + "）", "查詢：" + shortQuery, listContents_(result.direct), footer));
  } else {
    var notes = [{ type: "text", text: "院內沒有符合「" + shortQuery + "」的品項。", size: "sm", wrap: true }];
    if (outcome.source === "rxclass") {
      notes.push(noteText_("NLM RxClass：" + rxclassLine_(outcome), "#2f6f63"));
    } else if (outcome.rxclassError) {
      notes.push(noteText_("RxClass 查詢失敗：" + outcome.rxclassError));
    } else {
      notes.push(noteText_("RxClass 也查不到這個藥名（只支援英文藥名）。"));
    }
    if (outcome.source === "rxclass" && !result.sameIngredient.length && !result.classes.length) {
      notes.push(noteText_("院內也沒有同成分或同機轉的品項。"));
    }
    bubbles.push(bubble_("院內查藥", "查詢：" + shortQuery, notes, footer));
  }

  if (result.sameIngredient.length > 0) {
    bubbles.push(
      bubble_(
        (result.direct.length ? "同成分其他品項" : "院內同成分品項") + "（" + result.sameIngredient.length + "）",
        outcome.source === "rxclass" ? "藥名含 RxNorm 成分名" : "ATC 7 碼相同",
        listContents_(result.sameIngredient)
      )
    );
  }

  result.classes.slice(0, BOT.maxClassBubbles).forEach(function (group) {
    var className = outcome.classNames && outcome.classNames[group.atcClass];
    bubbles.push(
      bubble_(
        "同機轉 · ATC " + group.atcClass + "（" + group.items.length + "）",
        className || "ATC 前 5 碼相同",
        listContents_(group.items)
      )
    );
  });

  return {
    type: "flex",
    altText: truncate_(buildAltText_(query, outcome), 400),
    contents: bubbles.length === 1 ? bubbles[0] : { type: "carousel", contents: bubbles },
  };
}

function buildAltText_(query, outcome) {
  var result = outcome.result;
  var parts = [];
  if (result.direct.length) {
    parts.push("院內有此藥 " + result.direct.length + " 項");
  } else {
    parts.push("院內沒有此藥");
  }
  if (result.sameIngredient.length) {
    parts.push("同成分 " + result.sameIngredient.length + " 項");
  }
  result.classes.forEach(function (group) {
    parts.push("同機轉 " + group.atcClass + " " + group.items.length + " 項");
  });
  return BOT.name + "：" + query + " — " + parts.join("、");
}

// Plain-text version, used if LINE rejects the Flex message.
function buildPlainText_(query, outcome) {
  var result = outcome.result;
  var lines = [BOT.name + "：" + truncate_(query, 40)];
  var addItems = function (title, items) {
    lines.push("", "【" + title + "】");
    items.slice(0, BOT.maxItemsPerBubble).forEach(function (item) {
      lines.push("・" + item.name + (item.code ? "（" + item.code + "）" : ""));
      var meta = metaLine_(item);
      if (meta) {
        lines.push("　" + meta);
      }
    });
    if (items.length > BOT.maxItemsPerBubble) {
      lines.push("　…還有 " + (items.length - BOT.maxItemsPerBubble) + " 項");
    }
  };
  if (result.direct.length) {
    addItems("院內有此藥", result.direct);
  } else {
    lines.push("院內沒有符合的品項。");
    if (outcome.source === "rxclass") {
      lines.push("NLM RxClass：" + rxclassLine_(outcome));
    }
  }
  if (result.sameIngredient.length) {
    addItems(result.direct.length ? "同成分其他品項" : "院內同成分品項", result.sameIngredient);
  }
  result.classes.slice(0, BOT.maxClassBubbles).forEach(function (group) {
    addItems("同機轉 ATC " + group.atcClass, group.items);
  });
  return truncate_(lines.join("\n"), 4900);
}

function textMessage_(text) {
  return { type: "text", text: text };
}

function reply_(replyToken, messages, fallback) {
  var token = PropertiesService.getScriptProperties().getProperty("LINE_CHANNEL_ACCESS_TOKEN");
  if (!token) {
    throw new Error("Script property LINE_CHANNEL_ACCESS_TOKEN is not set");
  }
  var send = function (payloadMessages) {
    return UrlFetchApp.fetch("https://api.line.me/v2/bot/message/reply", {
      method: "post",
      contentType: "application/json",
      headers: { Authorization: "Bearer " + token },
      payload: JSON.stringify({ replyToken: replyToken, messages: payloadMessages }),
      muteHttpExceptions: true,
    });
  };

  var response = send(messages);
  var code = response.getResponseCode();
  // A rejected (invalid) message doesn't use up the reply token, so retry as text.
  if (code === 400 && fallback) {
    console.warn("Flex rejected, sending text: " + response.getContentText());
    response = send([fallback]);
    code = response.getResponseCode();
  }
  if (code !== 200) {
    console.error("LINE reply failed " + code + ": " + response.getContentText());
  }
}

// Run once from the Apps Script editor to check the sheet is readable.
function testLookup() {
  var outcome = resolve_("rosuvastatin");
  console.log(buildPlainText_("rosuvastatin", outcome));
}
