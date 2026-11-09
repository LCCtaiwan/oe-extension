// 院內查藥 · OE — page script of the Apps Script web app (gas/server.js).
// The phone keeps a copy of the formulary and matches with OEFormulary
// (src/formulary.js); RxClass and Groq go through google.script.run.

(function () {
  "use strict";

  var F = window.OEFormulary;
  if (!F) {
    throw new Error("院內比對模組沒有載入");
  }

  var CACHE_KEY = "oeGasFormulary";
  var CONFIG_KEY = "oeGasConfig";
  var HISTORY_KEY = "oeGasHistory";
  var HISTORY_ENABLED_KEY = "oeGasHistoryEnabled";
  var TOKEN_KEY = "oeGasToken";
  var HISTORY_LIMIT = 100;
  var FORM_LABELS = { O: "口服", I: "注射", E: "外用" };

  var $ = function (selector) {
    return document.querySelector(selector);
  };
  var queryInput = $("#query");
  var results = $("#results");
  var listStatus = $("#list-status");
  var engines = $("#engines");
  var aiActions = $("#ai-actions");
  var aiButtons = $("#ai-buttons");
  var aiPanel = $("#ai-panel");
  var aiTitle = $("#ai-title");
  var aiStatus = $("#ai-status");
  var aiOutput = $("#ai-output");
  var aiAsk = $("#ai-ask");
  var menu = $("#menu");
  var syncStatus = $("#sync-status");

  var index = F.createIndex([]);
  var cache = null;
  var config = { ai: false, prompts: [], appUrl: "", nhiUrl: "" };
  var searchToken = 0;
  var aiToken = 0;
  var aiSource = null; // { name, original } of the text in the AI panel
  var loaded = false;
  var token = ""; // ACCESS_TOKEN from the ?k= of the link this phone was given

  // ------------------------------------------------------------ helpers

  // Storage may be blocked in the Apps Script iframe (private mode, Safari's
  // third-party rules); everything still works, just without memory.
  function readStore(key, fallback) {
    try {
      var raw = window.localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (_error) {
      return fallback;
    }
  }

  function writeStore(key, value) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (_error) {
      return false;
    }
  }

  var CALL_TIMEOUT_MS = 25000;

  function call(name) {
    var args = Array.prototype.slice.call(arguments, 1);
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        reject(new Error("伺服器沒有回應。手機若登入多個 Google 帳號，請改用無痕視窗或只留一個帳號再試"));
      }, CALL_TIMEOUT_MS);
      try {
        var runner = google.script.run
          .withSuccessHandler(function (value) {
            clearTimeout(timer);
            resolve(value);
          })
          .withFailureHandler(function (error) {
            clearTimeout(timer);
            reject(error instanceof Error ? error : new Error(String((error && error.message) || error)));
          });
        runner[name].apply(runner, args);
      } catch (error) {
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) {
      node.className = className;
    }
    if (text !== undefined) {
      node.textContent = text;
    }
    return node;
  }

  function formatTime(timestamp) {
    if (!timestamp) {
      return "";
    }
    return new Date(timestamp).toLocaleString("zh-TW", {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  // The Apps Script iframe may not be granted clipboard access.
  function copyText(text) {
    var fallback = function () {
      var area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      area.setSelectionRange(0, text.length);
      var ok = false;
      try {
        ok = document.execCommand("copy");
      } catch (_error) {
        ok = false;
      }
      area.remove();
      return ok;
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(
        function () {
          return true;
        },
        function () {
          return fallback();
        }
      );
    }
    return Promise.resolve(fallback());
  }

  function flash(button, text) {
    var original = button.textContent;
    button.textContent = text;
    setTimeout(function () {
      button.textContent = original;
    }, 1200);
  }

  // Text shared from OpenEvidence, a PDF or a browser often carries the page
  // URL and quotes around the selection; keep only the selected words.
  function cleanSharedText(value) {
    return String(value || "")
      .replace(/https?:\/\/\S+/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
      .replace(/^["'“”「『]+|["'“”」』]+$/g, "")
      .trim();
  }

  // ------------------------------------------------------------- links

  function oeUrl(text) {
    return (
      "https://www.openevidence.com/ask?" +
      new URLSearchParams({ query: text, configName: "prod", attachments: "[]" }).toString()
    );
  }

  function updateEngines() {
    var text = queryInput.value.trim();
    engines.dataset.empty = text ? "false" : "true";
    $("#link-oe").href = text ? oeUrl(text) : "#";
    $("#link-utd").href = "https://www.uptodate.com/contents/search?" + new URLSearchParams({ search: text });
    $("#link-pubmed").href = "https://pubmed.ncbi.nlm.nih.gov/?" + new URLSearchParams({ term: text });
    $("#link-google").href = "https://www.google.com/search?" + new URLSearchParams({ q: text });
  }

  function autosize() {
    queryInput.style.height = "auto";
    queryInput.style.height = Math.min(queryInput.scrollHeight + 2, window.innerHeight * 0.4) + "px";
  }

  // ----------------------------------------------------------- history

  function historyEnabled() {
    return readStore(HISTORY_ENABLED_KEY, true) !== false;
  }

  function recordHistory(entry) {
    if (!historyEnabled()) {
      return;
    }
    var list = readStore(HISTORY_KEY, []);
    if (!Array.isArray(list)) {
      list = [];
    }
    var next = { ts: Date.now(), text: entry.text, source: entry.source || "直接" };
    if (entry.original && entry.original !== entry.text) {
      next.original = entry.original;
    }
    // Re-sending the same text moves it to the top instead of duplicating it.
    list = [next].concat(
      list.filter(function (item) {
        return item && item.text !== entry.text;
      })
    );
    writeStore(HISTORY_KEY, list.slice(0, HISTORY_LIMIT));
  }

  function renderHistory() {
    var list = readStore(HISTORY_KEY, []);
    var target = $("#history-list");
    target.textContent = "";
    if (!Array.isArray(list) || list.length === 0) {
      target.append(el("li", "hint", historyEnabled() ? "還沒有紀錄。" : "紀錄已關閉。"));
      return;
    }
    list.forEach(function (item) {
      var row = el("li");
      var button = el("button", "history-item");
      button.type = "button";
      button.append(el("span", "history-item__text", item.text));
      button.append(el("span", "history-item__meta", formatTime(item.ts) + " · " + item.source));
      button.addEventListener("click", function () {
        closeMenu();
        setQuery(item.original || item.text);
        if (item.original) {
          showAiResult(item.source, item.text, item.original);
        }
      });
      row.append(button);
      target.append(row);
    });
  }

  // --------------------------------------------------------- formulary

  function renderListStatus(message, state) {
    if (message) {
      listStatus.textContent = message;
      listStatus.dataset.state = state || "";
      return;
    }
    listStatus.dataset.state = "";
    listStatus.textContent =
      cache && cache.items && cache.items.length
        ? "院內清單 " + cache.items.length + " 項 · " + formatTime(cache.fetchedAt) + " 更新"
        : "尚未讀到院內清單";
  }

  function applyCache(next) {
    cache = next;
    index = F.createIndex((next && next.items) || []);
    renderListStatus();
  }

  function applyConfig(next) {
    config = next || { ai: false, prompts: [], appUrl: "", nhiUrl: "" };
    aiButtons.textContent = "";
    aiActions.hidden = !config.ai;
    $("#ai-note").hidden = !config.ai;
    if (!config.ai) {
      return;
    }
    var addChip = function (label, kind) {
      var chip = el("button", "ai-chip", label);
      chip.type = "button";
      chip.addEventListener("click", function () {
        runRewrite(kind, label);
      });
      aiButtons.append(chip);
    };
    addChip("PICO", "pico");
    (config.prompts || []).forEach(function (prompt, i) {
      addChip(prompt.name, i);
    });
  }

  // Applies a bootstrap (embedded in the page, or from getBootstrap); returns
  // whether the list changed.
  function applyBoot(boot) {
    var formulary = boot.formulary;
    var changed = Boolean(formulary.items);
    var next = {
      items: changed ? formulary.items : (cache && cache.items) || [],
      fingerprint: formulary.fingerprint,
      withAtc: formulary.withAtc,
      fetchedAt: Date.now(),
    };
    writeStore(CACHE_KEY, next);
    applyCache(next);
    var nextConfig = {
      ai: boot.ai,
      prompts: boot.prompts || [],
      appUrl: boot.appUrl || "",
      nhiUrl: boot.nhiUrl || "",
    };
    writeStore(CONFIG_KEY, nextConfig);
    applyConfig(nextConfig);
    loaded = true;
    syncStatus.dataset.state = "success";
    syncStatus.textContent =
      "已讀取 " + formulary.count + " 項（" + formulary.withAtc + " 項有 ATC 碼）" + (changed ? "" : "，清單沒有變動");
    return changed;
  }

  function syncFromServer(options) {
    var quiet = options && options.quiet;
    if (!quiet) {
      syncStatus.textContent = "讀取中…";
    }
    return call("getBootstrap", (cache && cache.fingerprint) || "", token, !quiet)
      .then(applyBoot)
      .catch(function (error) {
        syncStatus.dataset.state = "error";
        syncStatus.textContent = "讀取失敗：" + error.message;
        renderListStatus(
          cache && cache.items && cache.items.length
            ? "讀取失敗，使用 " + formatTime(cache.fetchedAt) + " 的清單"
            : "讀取院內清單失敗：" + error.message,
          "error"
        );
        return false;
      });
  }

  // ------------------------------------------------------------ results

  // The NHI page has no in-house code, so search it by the 7-character ATC
  // (every NHI product with that ingredient) or, failing that, the generic
  // name at the start of the in-house name ("Rosuvastatin (Crestor) …").
  function nhiQuery(item) {
    if (item.atc && item.atc.length === 7) {
      return item.atc;
    }
    var lead = String(item.name || "").split(/[(（\d]/)[0].trim();
    return lead.length >= 2 ? lead : "";
  }

  function nhiLink(query) {
    if (!config.nhiUrl || !query) {
      return null;
    }
    var link = el("a", "tag tag--nhi", "健保給付");
    link.href = config.nhiUrl + "?" + new URLSearchParams({ q: query }).toString();
    link.target = "_blank";
    link.rel = "noopener";
    link.title = "查健保給付規定（以 " + query + " 搜尋）";
    return link;
  }

  function drugItem(item) {
    var row = el("li", "drug");
    row.append(el("div", "drug__name", item.name));
    var meta = el("div", "drug__meta");
    if (item.code) {
      var code = el("button", "tag tag--code", item.code);
      code.type = "button";
      code.title = "複製批價碼";
      code.addEventListener("click", function () {
        copyText(item.code).then(function (ok) {
          if (ok) {
            flash(code, "已複製");
          }
        });
      });
      meta.append(code);
    }
    if (item.atc) {
      meta.append(el("span", "tag", "ATC " + item.atc));
    }
    if (item.form) {
      meta.append(el("span", "tag", FORM_LABELS[item.form] || item.form));
    }
    var prices = [];
    if (item.nhiPrice && item.nhiPrice !== "0") {
      prices.push("健保 " + item.nhiPrice);
    }
    if (item.selfPrice && item.selfPrice !== "0") {
      prices.push("自費 " + item.selfPrice);
    }
    if (prices.length) {
      meta.append(el("span", "tag", prices.join(" · ")));
    }
    if (Array.isArray(item.locations) && item.locations.length) {
      meta.append(
        el(
          "span",
          "tag tag--muted",
          item.locations
            .map(function (loc) {
              return String(loc[0]).replace(/儲位$/, "") + " " + loc[1];
            })
            .join(" · ")
        )
      );
    }
    var nhi = nhiLink(nhiQuery(item));
    if (nhi) {
      meta.append(nhi);
    }
    row.append(meta);
    return row;
  }

  function section(title, items, hint) {
    var wrap = el("section", "result-section");
    wrap.append(el("h2", "", title + "（" + items.length + "）"));
    if (hint) {
      wrap.append(el("p", "result-section__hint", hint));
    }
    var list = el("ul", "drug-list");
    items.forEach(function (item) {
      list.append(drugItem(item));
    });
    wrap.append(list);
    return wrap;
  }

  function uniqueLines(matches) {
    var seen = {};
    return matches
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
      });
  }

  function renderResult(result, extra) {
    extra = extra || {};
    var target = extra.target || results;
    target.textContent = "";
    var short = result.query.length > 40 ? result.query.slice(0, 40) + "…" : result.query;

    if (result.direct.length) {
      target.append(section("院內有此藥", result.direct));
    } else {
      target.append(el("p", "empty", "院內沒有符合「" + short + "」的品項。"));
      if (extra.rxclass && extra.rxclass.length) {
        target.append(el("p", "note note--source", "NLM RxClass：" + uniqueLines(extra.rxclass).join("、")));
      } else if (extra.aiGuesses && extra.aiGuesses.length) {
        target.append(
          el(
            "p",
            "note note--ai",
            "AI 推測（請自行核對）：" +
              extra.aiGuesses
                .map(function (g) {
                  return g.name + " → ATC " + g.atc;
                })
                .join("、")
          )
        );
      }
      (extra.notes || []).forEach(function (text) {
        target.append(el("p", "note", text));
      });
      if (extra.offerRemote) {
        var button = el("button", "button rx-button", "找院內同成分、同機轉品項");
        button.type = "button";
        button.addEventListener("click", function () {
          runSearch(result.query, { allowRemote: true });
        });
        target.append(button);
      }
    }

    if (result.sameIngredient.length) {
      target.append(
        section(
          result.direct.length ? "同成分其他品項" : "院內同成分品項",
          result.sameIngredient,
          extra.rxclass ? "藥名含 RxNorm 成分名" : "ATC 7 碼相同"
        )
      );
    }
    result.classes.forEach(function (group) {
      var name = extra.classNames && extra.classNames[group.atcClass];
      target.append(
        section(
          "同機轉 · ATC " + group.atcClass + (name ? " " + name : ""),
          group.items,
          "ATC 前 5 碼相同（同一化學／藥理次分類）"
        )
      );
    });
    if (
      !result.direct.length &&
      !result.sameIngredient.length &&
      !result.classes.length &&
      ((extra.rxclass && extra.rxclass.length) || (extra.aiGuesses && extra.aiGuesses.length))
    ) {
      target.append(el("p", "note", "院內也沒有同成分或同機轉的品項。"));
    }
  }

  // ------------------------------------------------- pasted answer mode

  // A pasted paragraph (an OpenEvidence answer, a note) is shown with the
  // in-house drug names marked; tapping one opens its result in a sheet,
  // like the extension's toolbar over a selection.
  var PASSAGE_MIN_LENGTH = 40;
  var mentionSheet = $("#mention-sheet");

  function isPassage(text) {
    return text.length >= PASSAGE_MIN_LENGTH || /\n/.test(text);
  }

  function mentionKey(term) {
    return term.normalize("NFKC").toLowerCase();
  }

  function hideMention() {
    mentionSheet.hidden = true;
    mentionSheet.textContent = "";
    results.querySelectorAll(".mention.is-active").forEach(function (node) {
      node.classList.remove("is-active");
    });
  }

  function linkButton(label, href, primary) {
    var link = el("a", "button button--link" + (primary ? " button--primary" : ""), label);
    link.href = href;
    link.target = "_blank";
    link.rel = "noopener";
    return link;
  }

  function showMention(term) {
    var key = mentionKey(term);
    results.querySelectorAll(".mention").forEach(function (node) {
      node.classList.toggle("is-active", node.dataset.key === key);
    });
    var local = F.lookup(index, term);
    mentionSheet.textContent = "";

    var head = el("div", "mention-sheet__head");
    head.append(el("h2", "", term));
    var close = el("button", "icon-button icon-button--small", "✕");
    close.type = "button";
    close.setAttribute("aria-label", "關閉");
    close.addEventListener("click", hideMention);
    head.append(close);

    var actions = el("div", "button-row");
    var ask = linkButton("問 OpenEvidence", oeUrl(term), true);
    ask.addEventListener("click", function () {
      recordHistory({ text: term, source: "文中藥名" });
    });
    actions.append(ask);
    if (config.nhiUrl) {
      var nhiTerm = (local.direct[0] && nhiQuery(local.direct[0])) || term;
      actions.append(linkButton("健保給付", config.nhiUrl + "?" + new URLSearchParams({ q: nhiTerm }), false));
    }
    actions.append(
      linkButton("UpToDate", "https://www.uptodate.com/contents/search?" + new URLSearchParams({ search: term }), false)
    );

    var body = el("div", "results");
    renderResult(local, { target: body });
    mentionSheet.append(head, actions, body);
    mentionSheet.hidden = false;
    mentionSheet.scrollTop = 0;
  }

  function mentionButton(term, className) {
    var button = el("button", className, term);
    button.type = "button";
    button.dataset.key = mentionKey(term);
    button.addEventListener("click", function () {
      showMention(term);
    });
    return button;
  }

  function renderPassage(text) {
    results.textContent = "";
    var mentions = F.findMentions(index, text);
    var unique = [];
    var seen = {};
    mentions.forEach(function (mention) {
      var key = mentionKey(mention.term);
      if (!seen[key]) {
        seen[key] = true;
        unique.push(mention.term);
      }
    });

    var wrap = el("section", "result-section passage-view");
    if (unique.length) {
      wrap.append(el("h2", "", "文中的院內藥名（" + unique.length + "）"));
      wrap.append(el("p", "result-section__hint", "點藥名看院內品項、健保給付，或直接問 OpenEvidence。"));
      var chips = el("div", "mention-chips");
      unique.forEach(function (term) {
        chips.append(mentionButton(term, "mention-chip"));
      });
      wrap.append(chips);
    } else {
      wrap.append(el("h2", "", "文中沒有找到院內藥名"));
      wrap.append(
        el("p", "result-section__hint", "沒標出的藥名可以單獨貼上查詢，會找院內同成分、同機轉的品項。")
      );
    }

    var passage = el("div", "passage");
    var cursor = 0;
    mentions.forEach(function (mention) {
      if (mention.start > cursor) {
        passage.append(document.createTextNode(text.slice(cursor, mention.start)));
      }
      passage.append(mentionButton(mention.term, "mention"));
      cursor = mention.end;
    });
    if (cursor < text.length) {
      passage.append(document.createTextNode(text.slice(cursor)));
    }
    wrap.append(passage);
    results.append(wrap);
  }

  function canGoRemote(query) {
    return F.rxclassTerms(query).length > 0 || config.ai;
  }

  // Typing only searches the list on the phone; RxClass / AI run on 查院內,
  // Enter, or text that arrives from another app.
  function runSearch(text, options) {
    var allowRemote = options && options.allowRemote;
    var query = String(text || "").trim();
    var mine = ++searchToken;
    hideMention();
    if (!query) {
      results.textContent = "";
      return Promise.resolve();
    }
    if (!index.items.length) {
      results.textContent = "";
      results.append(el("p", "empty", loaded ? "讀不到院內清單，請到右上角重新讀取。" : "院內清單讀取中…"));
      return Promise.resolve();
    }

    if (isPassage(query)) {
      renderPassage(query);
      return Promise.resolve();
    }

    var local = F.lookup(index, query);
    if (local.direct.length || !canGoRemote(query)) {
      renderResult(local);
      return Promise.resolve();
    }
    if (!allowRemote) {
      renderResult(local, { offerRemote: true });
      return Promise.resolve();
    }

    var notes = [];
    var tryAi = function () {
      if (!config.ai) {
        return renderResult(local, { notes: notes });
      }
      results.append(el("p", "loading", "請 AI 推測 ATC…"));
      return call("guessAtc", query, token).then(
        function (guesses) {
          if (mine !== searchToken) {
            return;
          }
          if (!guesses.length) {
            notes.push("AI 也認不出藥名。");
            return renderResult(local, { notes: notes });
          }
          var related = F.lookupByAtc(
            index,
            guesses.map(function (g) {
              return g.atc;
            })
          );
          renderResult(
            { query: local.query, direct: [], sameIngredient: related.sameIngredient, classes: related.classes },
            { aiGuesses: guesses, notes: notes }
          );
        },
        function (error) {
          if (mine === searchToken) {
            notes.push("AI 推測失敗：" + error.message);
            renderResult(local, { notes: notes });
          }
        }
      );
    };

    renderResult(local);
    if (F.rxclassTerms(query).length === 0) {
      notes.push("RxClass 只認得英文藥名。");
      return tryAi();
    }
    results.append(el("p", "loading", "向 NLM RxClass 查詢 ATC…"));
    return call("lookupRxClass", query, token).then(
      function (rxclass) {
        if (mine !== searchToken) {
          return;
        }
        if (!rxclass.length) {
          notes.push("RxClass 查不到這個藥名。");
          return tryAi();
        }
        var related = F.lookupByIngredients(index, rxclass);
        renderResult(
          { query: local.query, direct: [], sameIngredient: related.sameIngredient, classes: related.classes },
          { rxclass: rxclass, classNames: related.classNames }
        );
      },
      function (error) {
        if (mine !== searchToken) {
          return;
        }
        notes.push("RxClass 查詢失敗：" + error.message);
        return tryAi();
      }
    );
  }

  // ---------------------------------------------------------------- AI

  function updateAiAsk() {
    var text = aiOutput.value.trim();
    aiAsk.href = text ? oeUrl(text) : "#";
    aiAsk.setAttribute("aria-disabled", text ? "false" : "true");
  }

  function showAiResult(name, text, original) {
    aiSource = { name: name, original: original };
    aiTitle.textContent = name;
    aiStatus.hidden = true;
    aiOutput.value = text;
    aiPanel.hidden = false;
    updateAiAsk();
  }

  function setAiBusy(busy) {
    aiButtons.querySelectorAll("button").forEach(function (button) {
      button.disabled = busy;
    });
  }

  function runRewrite(kind, label) {
    var original = queryInput.value.trim();
    if (!original) {
      queryInput.focus();
      return;
    }
    var mine = ++aiToken;
    aiSource = { name: label, original: original };
    aiTitle.textContent = label;
    aiOutput.value = "";
    updateAiAsk();
    aiStatus.hidden = false;
    aiStatus.dataset.state = "";
    aiStatus.textContent = "AI 改寫中…";
    aiPanel.hidden = false;
    setAiBusy(true);
    call("rewriteText", kind, original, token)
      .then(function (reply) {
        if (mine === aiToken) {
          showAiResult(reply.name, reply.text, original);
        }
      })
      .catch(function (error) {
        if (mine === aiToken) {
          aiStatus.dataset.state = "error";
          aiStatus.textContent = "改寫失敗：" + error.message;
        }
      })
      .then(function () {
        setAiBusy(false);
      });
  }

  aiOutput.addEventListener("input", updateAiAsk);

  aiAsk.addEventListener("click", function (event) {
    var text = aiOutput.value.trim();
    if (!text) {
      event.preventDefault();
      return;
    }
    recordHistory({
      text: text,
      source: (aiSource && aiSource.name) || "AI",
      original: aiSource && aiSource.original,
    });
  });

  $("#ai-copy").addEventListener("click", function (event) {
    var button = event.currentTarget;
    copyText(aiOutput.value.trim()).then(function (ok) {
      flash(button, ok ? "已複製" : "請手動複製");
    });
  });

  $("#ai-use").addEventListener("click", function () {
    var text = aiOutput.value.trim();
    if (text) {
      setQuery(text, { search: false });
      aiPanel.hidden = true;
    }
  });

  $("#ai-close").addEventListener("click", function () {
    aiToken += 1;
    aiPanel.hidden = true;
    setAiBusy(false);
  });

  // -------------------------------------------------------------- input

  function setQuery(text, options) {
    queryInput.value = text;
    autosize();
    updateEngines();
    if (!options || options.search !== false) {
      runSearch(text, { allowRemote: true });
    }
  }

  var typingTimer = null;
  queryInput.addEventListener("input", function () {
    autosize();
    updateEngines();
    clearTimeout(typingTimer);
    typingTimer = setTimeout(function () {
      runSearch(queryInput.value, { allowRemote: false });
    }, 150);
  });

  // Enter searches; Shift+Enter (or a pasted paragraph) keeps line breaks.
  queryInput.addEventListener("keydown", function (event) {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      $("#search-form").requestSubmit();
    }
  });

  $("#search-form").addEventListener("submit", function (event) {
    event.preventDefault();
    clearTimeout(typingTimer);
    queryInput.blur();
    runSearch(queryInput.value, { allowRemote: true });
  });

  // Pasting from the iOS callout (the page can't read the clipboard by
  // itself) searches right away, so copy → open → paste is the whole flow.
  queryInput.addEventListener("paste", function () {
    setTimeout(function () {
      var clean = cleanSharedText(queryInput.value);
      if (clean) {
        clearTimeout(typingTimer);
        setQuery(clean);
        queryInput.blur();
      }
    }, 0);
  });

  $("#paste").addEventListener("click", function () {
    var fail = function () {
      queryInput.focus();
      renderListStatus("這個瀏覽器不允許直接讀取剪貼簿，請長按輸入框貼上", "error");
      setTimeout(function () {
        renderListStatus();
      }, 3000);
    };
    if (!navigator.clipboard || !navigator.clipboard.readText) {
      fail();
      return;
    }
    navigator.clipboard.readText().then(function (text) {
      var clean = cleanSharedText(text);
      if (clean) {
        setQuery(clean);
      }
    }, fail);
  });

  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && !mentionSheet.hidden) {
      hideMention();
    }
  });

  $("#clear").addEventListener("click", function () {
    setQuery("", { search: false });
    results.textContent = "";
    queryInput.focus();
  });

  $("#link-oe").addEventListener("click", function (event) {
    var text = queryInput.value.trim();
    if (!text) {
      event.preventDefault();
      return;
    }
    recordHistory({ text: text, source: "直接" });
  });

  // --------------------------------------------------------------- menu

  function closeMenu() {
    if (typeof menu.close === "function") {
      menu.close();
    } else {
      menu.removeAttribute("open");
    }
  }

  $("#open-menu").addEventListener("click", function () {
    renderHistory();
    $("#history-enabled").checked = historyEnabled();
    var withToken = function (query) {
      return config.appUrl + "?" + query + (token ? "&k=" + encodeURIComponent(token) : "");
    };
    $("#shortcut-post").textContent = config.appUrl ? withToken("api=lookup") : "（部署後才會顯示網址）";
    $("#shortcut-lookup").textContent = config.appUrl ? withToken("api=lookup") + "&q=" : "（部署後才會顯示網址）";
    $("#shortcut-pico").textContent = config.appUrl ? withToken("api=pico") + "&q=" : "（部署後才會顯示網址）";
    $("#shortcut-nhi").textContent = config.nhiUrl ? config.nhiUrl + "?q=" : "（未設定健保查詢頁）";
    $("#page-url").textContent = config.appUrl
      ? config.appUrl + "?" + (token ? "k=" + encodeURIComponent(token) + "&" : "") + "q="
      : "（部署後才會顯示網址）";
    if (!syncStatus.textContent && cache && cache.items) {
      syncStatus.textContent = "目前清單：" + cache.items.length + " 項，" + formatTime(cache.fetchedAt) + " 更新";
    }
    if (typeof menu.showModal === "function") {
      menu.showModal();
    } else {
      menu.setAttribute("open", "");
    }
  });

  $("#history-enabled").addEventListener("change", function (event) {
    writeStore(HISTORY_ENABLED_KEY, event.currentTarget.checked);
    renderHistory();
  });

  $("#history-clear").addEventListener("click", function () {
    if (window.confirm("清除這支手機上的查詢紀錄？")) {
      writeStore(HISTORY_KEY, []);
      renderHistory();
    }
  });

  $("#sync-now").addEventListener("click", function () {
    syncFromServer().then(function (changed) {
      if (changed && queryInput.value.trim()) {
        runSearch(queryInput.value, { allowRemote: false });
      }
    });
  });

  // --------------------------------------------------------------- boot

  // Any script error ends up on screen instead of an endless 讀取中….
  window.addEventListener("error", function (event) {
    renderListStatus("頁面錯誤：" + (event.message || "未知錯誤") + "（請截圖回報）", "error");
  });

  // doGet writes the list, settings and ?q= / ?k= into the page (OE_BOOT).
  // Missing/non-object data means bootstrap injection failed, not a proven old server.
  var BOOT = window.OE_BOOT && typeof window.OE_BOOT === "object" ? window.OE_BOOT : null;
  var PAGE_BUILD = window.OE_PAGE_BUILD || "";
  $(".footnote").append(el("span", "footnote__build", " 版本 " + PAGE_BUILD));

  // Code.gs and Index.html must come from the same version.
  function versionProblem() {
    if (!BOOT) {
      return "頁面啟動資料未載入：請確認 Code.gs 與 Index 來自同一次建置，並已部署新版本";
    }
    if (BOOT.build && PAGE_BUILD && BOOT.build !== PAGE_BUILD) {
      return "Code.gs（" + BOOT.build + "）和 Index（" + PAGE_BUILD + "）版本不同：請兩個檔都重新貼上並部署新版本";
    }
    return "";
  }
  token = readStore(TOKEN_KEY, "") || "";
  if (BOOT && BOOT.k) {
    token = String(BOOT.k);
    writeStore(TOKEN_KEY, token);
  }

  applyCache(readStore(CACHE_KEY, null));
  applyConfig(readStore(CONFIG_KEY, null));
  if (BOOT && BOOT.formulary && BOOT.formulary.items) {
    applyBoot(BOOT);
  }
  updateEngines();

  var incoming = cleanSharedText((BOOT && BOOT.q) || "");
  if (incoming) {
    setQuery(incoming, { search: false });
    if (index.items.length && !(BOOT && BOOT.formulary && BOOT.formulary.items)) {
      // Show a remembered list's result while the fresh list loads.
      runSearch(incoming, { allowRemote: false });
    }
  } else {
    queryInput.focus({ preventScroll: true });
  }

  var problem = versionProblem();
  if (problem) {
    renderListStatus(problem, "error");
    loaded = true;
    if (index.items.length && incoming) {
      runSearch(incoming, { allowRemote: false });
    }
  } else if (loaded) {
    if (incoming) {
      runSearch(incoming, { allowRemote: true });
    }
  } else if (BOOT && BOOT.error) {
    renderListStatus("讀取院內清單失敗：" + BOOT.error, "error");
    loaded = true;
  } else if (BOOT && BOOT.needsToken && !token) {
    renderListStatus("請用帶有存取碼（k=）的連結打開本頁", "error");
    loaded = true;
  } else {
    // Opened without the list embedded (no ?k= on this visit, but the phone
    // remembers one): fetch it with the saved code.
    if (!cache || !cache.items || !cache.items.length) {
      renderListStatus("讀取院內清單中…");
    }
    syncFromServer({ quiet: true }).then(function () {
      loaded = true;
      var text = queryInput.value.trim();
      if (text) {
        runSearch(text, { allowRemote: Boolean(incoming) });
      }
    });
  }
})();
