// 院內查藥 — mobile web app. Shares src/formulary.js (OEFormulary) with the
// Chrome extension; the formulary itself comes from one published Google
// Sheet and is cached on the device so lookups also work offline.

(function () {
  const F = window.OEFormulary;

  const URL_KEY = "oeFormularyUrl";
  const CACHE_KEY = "oeFormularyCache";
  const RXCLASS_KEY = "oeRxClassEnabled";
  const RESYNC_AFTER_MS = 30 * 60 * 1000;
  const RXCLASS_TIMEOUT_MS = 8000;
  const FORM_LABELS = { O: "口服", I: "注射", E: "外用" };

  const $ = (selector) => document.querySelector(selector);
  const queryInput = $("#query");
  const results = $("#results");
  const listStatus = $("#list-status");
  const onboarding = $("#onboarding");
  const externalLinks = $("#external-links");
  const settings = $("#settings");
  const sheetUrlInput = $("#sheet-url");
  const syncStatus = $("#sync-status");
  const rxclassCheckbox = $("#rxclass-enabled");

  let index = F.createIndex([]);
  let cache = null;
  let syncing = null;
  let searchToken = 0;
  const rxclassCache = new Map();

  // ------------------------------------------------------------- storage

  function readStore(key, fallback) {
    try {
      const raw = window.localStorage.getItem(key);
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

  function removeStore(key) {
    try {
      window.localStorage.removeItem(key);
    } catch (_error) {
      // Nothing to clear when storage is unavailable.
    }
  }

  // ---------------------------------------------------------------- sync

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

  function renderListStatus(message, state) {
    if (message) {
      listStatus.textContent = message;
      listStatus.dataset.state = state || "";
      return;
    }
    if (!cache?.items?.length) {
      listStatus.textContent = readStore(URL_KEY, "")
        ? "尚未下載院內清單"
        : "尚未設定院內清單";
      listStatus.dataset.state = "";
      return;
    }
    listStatus.textContent = `院內清單 ${cache.items.length} 項 · ${formatTime(cache.fetchedAt)} 更新`;
    listStatus.dataset.state = "";
  }

  function setSyncStatus(message, state) {
    syncStatus.textContent = message;
    syncStatus.dataset.state = state || "";
  }

  function applyCache(next) {
    cache = next;
    index = F.createIndex(next?.items || []);
    onboarding.hidden = Boolean(next?.items?.length) || Boolean(readStore(URL_KEY, ""));
    renderListStatus();
  }

  async function syncFormulary({ quiet = false } = {}) {
    const sourceUrl = readStore(URL_KEY, "");
    const csvUrl = F.sheetCsvUrl(sourceUrl);
    if (!csvUrl) {
      return false;
    }
    if (syncing) {
      return syncing;
    }

    if (!quiet) {
      setSyncStatus("同步中…");
    }
    syncing = (async () => {
      try {
        const response = await fetch(csvUrl, { cache: "no-store" });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const parsed = F.parseFormularyText(await response.text());
        if (parsed.items.length === 0) {
          throw new Error("清單裡沒有任何品項");
        }
        const fingerprint = F.formularyFingerprint(parsed.items);
        const changed = fingerprint !== cache?.fingerprint;
        const next = {
          items: parsed.items,
          withAtc: parsed.withAtc,
          missingColumns: parsed.missingColumns,
          fingerprint,
          fetchedAt: Date.now(),
        };
        if (!writeStore(CACHE_KEY, next)) {
          throw new Error("這台裝置無法儲存清單（瀏覽器儲存空間被停用）");
        }
        applyCache(next);
        setSyncStatus(
          `已同步 ${parsed.items.length} 項（${parsed.withAtc} 項有 ATC 碼）${changed ? "" : "，清單沒有變動"}`,
          "success",
        );
        if (changed && queryInput.value.trim()) {
          runSearch(queryInput.value, { allowRemote: false });
        }
        return true;
      } catch (caught) {
        // fetch() rejects with a bare TypeError when offline or blocked.
        const error =
          caught instanceof TypeError ? new Error("連不上試算表（沒有網路，或連結無法存取）") : caught;
        const hint = /藥名/.test(error.message)
          ? "。請確認試算表已「發布到網路」為 CSV，或設為「知道連結的人可檢視」。"
          : "";
        setSyncStatus(`同步失敗：${error.message}${hint}`, "error");
        renderListStatus(
          cache?.items?.length
            ? `同步失敗，使用 ${formatTime(cache.fetchedAt)} 的清單`
            : "同步失敗，請到設定檢查連結",
          "error",
        );
        return false;
      } finally {
        syncing = null;
      }
    })();
    return syncing;
  }

  // ------------------------------------------------------------- RxClass

  async function fetchRxClass(term) {
    const key = term.toLowerCase();
    if (rxclassCache.has(key)) {
      return rxclassCache.get(key);
    }
    const params = new URLSearchParams({ drugName: term, relaSource: "ATC" });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RXCLASS_TIMEOUT_MS);
    try {
      const response = await fetch(
        `https://rxnav.nlm.nih.gov/REST/rxclass/class/byDrugName.json?${params}`,
        { signal: controller.signal },
      );
      if (response.status === 404) {
        return [];
      }
      if (!response.ok) {
        throw new Error(`RxClass HTTP ${response.status}`);
      }
      const matches = F.parseRxClassResponse(await response.json().catch(() => ({})));
      rxclassCache.set(key, matches);
      return matches;
    } catch (error) {
      throw error.name === "AbortError" ? new Error("RxClass 逾時") : error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function lookupRxClass(text) {
    const terms = F.rxclassTerms(text);
    if (terms.length === 0) {
      return [];
    }
    const settled = await Promise.allSettled(terms.map(fetchRxClass));
    const failures = settled.filter((entry) => entry.status === "rejected");
    if (failures.length === settled.length) {
      throw failures[0].reason;
    }
    const perTerm = settled.map((entry, i) => ({
      term: terms[i],
      matches: entry.status === "fulfilled" ? entry.value : [],
    }));
    const phraseHit = perTerm[0].term.includes(" ") && perTerm[0].matches.length > 0;
    return (phraseHit ? perTerm.slice(0, 1) : perTerm).flatMap(({ matches }) => matches);
  }

  function rxclassEnabled() {
    return readStore(RXCLASS_KEY, true) !== false;
  }

  // -------------------------------------------------------------- render

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) {
      node.className = className;
    }
    if (text !== undefined) {
      node.textContent = text;
    }
    return node;
  }

  function drugItem(item) {
    const row = el("li", "drug");
    row.append(el("div", "drug__name", item.name));
    const meta = el("div", "drug__meta");

    if (item.code) {
      const code = el("button", "tag tag--code", item.code);
      code.type = "button";
      code.title = "複製批價碼";
      code.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(item.code);
          code.textContent = "已複製";
          setTimeout(() => {
            code.textContent = item.code;
          }, 1200);
        } catch (_error) {
          // Clipboard blocked: leave the code visible to copy by hand.
        }
      });
      meta.append(code);
    }
    if (item.atc) {
      meta.append(el("span", "tag", `ATC ${item.atc}`));
    }
    if (item.form) {
      meta.append(el("span", "tag", FORM_LABELS[item.form] || item.form));
    }
    const prices = [];
    if (item.nhiPrice && item.nhiPrice !== "0") {
      prices.push(`健保 ${item.nhiPrice}`);
    }
    if (item.selfPrice && item.selfPrice !== "0") {
      prices.push(`自費 ${item.selfPrice}`);
    }
    if (prices.length) {
      meta.append(el("span", "tag", prices.join(" · ")));
    }
    if (Array.isArray(item.locations) && item.locations.length) {
      meta.append(
        el(
          "span",
          "tag tag--muted",
          item.locations.map(([label, value]) => `${label.replace(/儲位$/, "")} ${value}`).join(" · "),
        ),
      );
    }
    row.append(meta);
    return row;
  }

  function section(title, items, hint) {
    const wrap = el("section", "result-section");
    wrap.append(el("h2", "", `${title}（${items.length}）`));
    if (hint) {
      wrap.append(el("p", "result-section__hint", hint));
    }
    const list = el("ul", "drug-list");
    items.forEach((item) => list.append(drugItem(item)));
    wrap.append(list);
    return wrap;
  }

  function renderResult(result, extra = {}) {
    results.textContent = "";
    const short = result.query.length > 60 ? `${result.query.slice(0, 60)}…` : result.query;

    if (result.direct.length) {
      results.append(section("院內有此藥", result.direct));
    } else {
      results.append(el("p", "empty", `院內沒有符合「${short}」的品項。`));
      if (extra.rxclass?.length) {
        const seen = new Set();
        const lines = extra.rxclass
          .filter((match) => {
            const key = `${match.ingredient}|${match.atcClass}`;
            return seen.has(key) ? false : seen.add(key);
          })
          .map((match) => `${match.ingredient} → ATC ${match.atcClass}${match.className ? ` ${match.className}` : ""}`);
        results.append(el("p", "note note--source", `NLM RxClass：${lines.join("、")}`));
      } else if (extra.rxclassError) {
        results.append(el("p", "note", `RxClass 查詢失敗：${extra.rxclassError}`));
      } else if (extra.rxclassEmpty) {
        results.append(el("p", "note", "RxClass 也查不到這個藥名（只支援英文藥名）。"));
      } else if (extra.offerRxClass) {
        const button = el("button", "button rx-button", "用 RxClass 找同機轉品項");
        button.type = "button";
        button.addEventListener("click", () => runSearch(result.query, { allowRemote: true }));
        results.append(button);
      }
    }

    if (result.sameIngredient.length) {
      results.append(
        section(
          result.direct.length ? "同成分其他品項" : "院內同成分品項",
          result.sameIngredient,
          extra.rxclass?.length ? "藥名含 RxNorm 成分名" : "ATC 7 碼相同",
        ),
      );
    }

    result.classes.forEach((group) => {
      const name = extra.classNames?.[group.atcClass];
      results.append(
        section(
          `同機轉 · ATC ${group.atcClass}${name ? ` ${name}` : ""}`,
          group.items,
          "ATC 前 5 碼相同（同一化學／藥理次分類）",
        ),
      );
    });

    if (
      !result.direct.length &&
      !result.sameIngredient.length &&
      !result.classes.length &&
      extra.rxclass?.length
    ) {
      results.append(el("p", "note", "院內也沒有同成分或同機轉的品項。"));
    }
  }

  function updateExternalLinks(text) {
    const query = text.trim();
    externalLinks.hidden = !query;
    if (!query) {
      return;
    }
    const oe = new URLSearchParams({ query, configName: "prod", attachments: "[]" });
    $("#link-oe").href = `https://www.openevidence.com/ask?${oe}`;
    $("#link-utd").href = `https://www.uptodate.com/contents/search?${new URLSearchParams({ search: query })}`;
    $("#link-pubmed").href = `https://pubmed.ncbi.nlm.nih.gov/?${new URLSearchParams({ term: query })}`;
    $("#link-google").href = `https://www.google.com/search?${new URLSearchParams({ q: query })}`;
  }

  // allowRemote: typing only searches the on-device list; RxClass runs on an
  // explicit search (Enter, the 查詢 button, or text shared from another app).
  async function runSearch(text, { allowRemote }) {
    const query = String(text || "").trim();
    const token = ++searchToken;
    updateExternalLinks(query);
    if (!query) {
      results.textContent = "";
      return;
    }
    if (!index.items.length) {
      results.textContent = "";
      results.append(el("p", "empty", "還沒有院內清單。請到右上角「設定」貼上 Google 試算表連結。"));
      return;
    }

    const local = F.lookup(index, query);
    const canUseRxClass = rxclassEnabled() && F.rxclassTerms(query).length > 0;
    if (local.direct.length || !canUseRxClass) {
      renderResult(local);
      return;
    }
    if (!allowRemote) {
      renderResult(local, { offerRxClass: true });
      return;
    }

    renderResult(local);
    results.append(el("p", "loading", "向 NLM RxClass 查詢 ATC…"));
    try {
      const rxclass = await lookupRxClass(query);
      if (token !== searchToken) {
        return;
      }
      if (!rxclass.length) {
        renderResult(local, { rxclassEmpty: true });
        return;
      }
      const related = F.lookupByIngredients(index, rxclass);
      renderResult(
        { ...local, sameIngredient: related.sameIngredient, classes: related.classes },
        { rxclass, classNames: related.classNames },
      );
    } catch (error) {
      if (token === searchToken) {
        const message =
          !navigator.onLine ? "目前沒有網路" : error instanceof TypeError ? "連不上 RxClass（可能被網路擋住）" : error.message;
        renderResult(local, { rxclassError: message });
      }
    }
  }

  // ------------------------------------------------------- incoming text

  // Text shared from OpenEvidence, a PDF reader or a browser often carries the
  // page URL and quotes around the selection; keep only the selected words.
  function cleanSharedText(value) {
    return String(value || "")
      .replace(/https?:\/\/\S+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^["'“”「『]+|["'“”」』]+$/g, "")
      .trim();
  }

  // The fragment is never sent to the web server, so setup links and the
  // iPhone shortcut put the sheet URL (src) and the query (q) there.
  function hashParams() {
    return new URLSearchParams(window.location.hash.replace(/^#/, ""));
  }

  // ?text= / ?title= come from the Android share sheet, ?q= / #q= from links
  // and the iPhone shortcut.
  function readIncomingQuery() {
    const params = new URLSearchParams(window.location.search);
    const hash = hashParams();
    const shared = [hash.get("q"), params.get("q"), params.get("text"), params.get("title")]
      .map(cleanSharedText)
      .find(Boolean);
    return shared || "";
  }

  function readSetupLink() {
    return hashParams().get("src") || "";
  }

  function cleanAddressBar() {
    const clean = window.location.pathname;
    if (window.location.search || window.location.hash) {
      window.history.replaceState(null, "", clean);
    }
  }

  function appBaseUrl() {
    return `${window.location.origin}${window.location.pathname}`;
  }

  // ------------------------------------------------------------ settings

  function openSettings() {
    sheetUrlInput.value = readStore(URL_KEY, "");
    rxclassCheckbox.checked = rxclassEnabled();
    // Shortcuts open Safari, whose storage is separate from the home-screen
    // app on iPhone, so the link carries the sheet URL as well.
    const source = readStore(URL_KEY, "");
    $("#shortcut-url").textContent = source
      ? `${appBaseUrl()}#src=${encodeURIComponent(source)}&q=`
      : "（請先設定試算表連結）";
    if (!syncStatus.textContent && cache?.items?.length) {
      setSyncStatus(`目前清單：${cache.items.length} 項，${formatTime(cache.fetchedAt)} 更新`);
    }
    if (typeof settings.showModal === "function") {
      settings.showModal();
    } else {
      settings.setAttribute("open", "");
    }
  }

  $("#open-settings").addEventListener("click", openSettings);
  $("#onboarding-settings").addEventListener("click", openSettings);

  $("#save-url").addEventListener("click", async () => {
    const value = sheetUrlInput.value.trim();
    if (!F.sheetCsvUrl(value)) {
      setSyncStatus("請貼上 https 開頭的 Google 試算表連結", "error");
      return;
    }
    writeStore(URL_KEY, value);
    onboarding.hidden = true;
    await syncFormulary();
  });

  $("#sync-now").addEventListener("click", () => syncFormulary());

  rxclassCheckbox.addEventListener("change", () => {
    writeStore(RXCLASS_KEY, rxclassCheckbox.checked);
  });

  $("#copy-setup-link").addEventListener("click", async () => {
    const source = readStore(URL_KEY, "");
    if (!source) {
      setSyncStatus("請先設定試算表連結", "error");
      return;
    }
    const link = `${appBaseUrl()}#${new URLSearchParams({ src: source })}`;
    try {
      await navigator.clipboard.writeText(link);
      setSyncStatus("已複製設定連結，可以貼到 LINE 傳給同事", "success");
    } catch (_error) {
      window.prompt("複製這個設定連結：", link);
    }
  });

  $("#clear-local").addEventListener("click", () => {
    if (!window.confirm("清除這台裝置上的試算表連結與院內清單？")) {
      return;
    }
    removeStore(URL_KEY);
    removeStore(CACHE_KEY);
    applyCache(null);
    results.textContent = "";
    setSyncStatus("已清除");
  });

  // -------------------------------------------------------------- search

  let typingTimer = null;
  queryInput.addEventListener("input", () => {
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => runSearch(queryInput.value, { allowRemote: false }), 150);
  });

  $("#search-form").addEventListener("submit", (event) => {
    event.preventDefault();
    clearTimeout(typingTimer);
    queryInput.blur();
    runSearch(queryInput.value, { allowRemote: true });
  });

  $("#paste").addEventListener("click", async () => {
    try {
      const text = cleanSharedText(await navigator.clipboard.readText());
      if (text) {
        queryInput.value = text;
        runSearch(text, { allowRemote: true });
      }
    } catch (_error) {
      queryInput.focus();
    }
  });

  // ---------------------------------------------------------------- boot

  async function boot() {
    const setupSource = readSetupLink();
    if (setupSource && F.sheetCsvUrl(setupSource)) {
      writeStore(URL_KEY, setupSource);
    }
    const incoming = readIncomingQuery();
    cleanAddressBar();

    applyCache(readStore(CACHE_KEY, null));

    if (incoming) {
      queryInput.value = incoming;
    }

    const needsFirstDownload = !cache?.items?.length && readStore(URL_KEY, "");
    if (needsFirstDownload) {
      renderListStatus("下載院內清單中…");
      await syncFormulary({ quiet: true });
    } else if (readStore(URL_KEY, "")) {
      syncFormulary({ quiet: true });
    }

    if (incoming) {
      runSearch(incoming, { allowRemote: true });
    } else {
      queryInput.focus({ preventScroll: true });
    }
  }

  document.addEventListener("visibilitychange", () => {
    if (
      document.visibilityState === "visible" &&
      readStore(URL_KEY, "") &&
      Date.now() - (cache?.fetchedAt || 0) > RESYNC_AFTER_MS
    ) {
      syncFormulary({ quiet: true });
    }
  });

  if ("serviceWorker" in navigator && window.location.protocol === "https:") {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  boot();
})();
