// Shared formulary parser/matcher; exposes self.OEFormulary.
importScripts("formulary.js");

const DEFAULT_WHITELIST = [
	"https://ankiuser.net/study",
	"https://www.openevidence.com/*",
	"http://uptodate.com/*",
	"nejm.org/*",
	"https://accessmedicine.mhmedical.com/*",
	"https://www.clinicalkey.com/*",
	"file:///*",
];
const STORAGE_KEY = "oeWhitelist";
const ACTIVE_TAB_STORAGE_KEY = "oeOpenInActiveTab";
const DEFAULT_OPEN_IN_ACTIVE_TAB = false;
const OPEN_MODE_STORAGE_KEY = "oeOpenMode";
const OPEN_MODE_TAB_BG = "tab-bg";
const OPEN_MODE_TAB_ACTIVE = "tab-active";
const OPEN_MODE_SIDE_PANE = "side-pane";
const DEFAULT_OPEN_MODE = OPEN_MODE_TAB_BG;
const SIDE_PANEL_URL_KEY = "oeSidePanelUrl";
const GROQ_API_KEY_STORAGE_KEY = "oeGroqApiKey";
const GROQ_VALIDATED_STORAGE_KEY = "oeGroqApiKeyValidated";
const GROQ_MODEL = "llama-3.3-70b-versatile";
const GROQ_TIMEOUT_MS = 30000;
const ASK_CONTEXT_MENU_ID = "oe-ask-selection";
const HISTORY_STORAGE_KEY = "oeHistory";
const HISTORY_ENABLED_STORAGE_KEY = "oeHistoryEnabled";
const DEFAULT_HISTORY_ENABLED = true;
const HISTORY_LIMIT = 200;
const PICO_INSTRUCTION = `Rewrite my recall question as an EBM foreground question. Shift "what/which" to "what's the evidence for/why." Impose PICO (population, intervention/exposure, comparator, outcome) and pick the right question type (therapy/diagnosis/prognosis). Require cited evidence, guideline comparison, and clinical implications--not just definitions.

Export as JSON:
{"question":"$output"}`;

function buildOpenEvidenceUrl(query) {
	const params = new URLSearchParams({
		query,
		configName: "prod",
		attachments: "[]",
		_rsc: "1pln2",
	});

	return `https://www.openevidence.com/ask?${params.toString()}`;
}

function buildUpToDateUrl(query) {
	const params = new URLSearchParams({ search: query });
	return `https://www.uptodate.com/contents/search?${params.toString()}`;
}

function buildGoogleUrl(query) {
	const params = new URLSearchParams({
		q: query,
		sourceid: "chrome",
		ie: "UTF-8",
	});
	return `https://www.google.com/search?${params.toString()}`;
}

let historyIdCounter = 0;

function buildHistoryEntry(entry) {
	historyIdCounter += 1;
	const normalized = {
		id: `${Date.now()}-${historyIdCounter}`,
		timestamp: Date.now(),
		url: typeof entry.url === "string" ? entry.url : "",
		finalText: typeof entry.finalText === "string" ? entry.finalText : "",
		source: typeof entry.source === "string" ? entry.source : "selection",
	};

	if (typeof entry.original === "string" && entry.original) {
		normalized.original = entry.original;
	}
	if (typeof entry.promptName === "string" && entry.promptName) {
		normalized.promptName = entry.promptName;
	}
	if (typeof entry.promptInstruction === "string" && entry.promptInstruction) {
		normalized.promptInstruction = entry.promptInstruction;
	}
	if (typeof entry.transformed === "string" && entry.transformed) {
		normalized.transformed = entry.transformed;
	}

	return normalized;
}

function recordHistory(entry) {
	chrome.storage.sync.get(
		{ [HISTORY_ENABLED_STORAGE_KEY]: DEFAULT_HISTORY_ENABLED },
		(syncItems) => {
			if (syncItems[HISTORY_ENABLED_STORAGE_KEY] === false) {
				return;
			}

			chrome.storage.local.get({ [HISTORY_STORAGE_KEY]: [] }, (items) => {
				const existing = Array.isArray(items[HISTORY_STORAGE_KEY])
					? items[HISTORY_STORAGE_KEY]
					: [];
				const next = [buildHistoryEntry(entry), ...existing].slice(
					0,
					HISTORY_LIMIT,
				);
				chrome.storage.local.set({ [HISTORY_STORAGE_KEY]: next });
			});
		},
	);
}

function resolveOpenMode(items) {
	const mode = items[OPEN_MODE_STORAGE_KEY];
	if (
		mode === OPEN_MODE_TAB_BG ||
		mode === OPEN_MODE_TAB_ACTIVE ||
		mode === OPEN_MODE_SIDE_PANE
	) {
		return mode;
	}

	// Migrate the legacy boolean for users who set it before the 3-way mode.
	return items[ACTIVE_TAB_STORAGE_KEY] === true
		? OPEN_MODE_TAB_ACTIVE
		: DEFAULT_OPEN_MODE;
}

// Cached synchronously so the side-panel open() call can run inside the user
// gesture that triggered the message — chrome.storage reads are async and would
// break the gesture chain, leaving sidePanel.open() to reject.
let openModeCache = DEFAULT_OPEN_MODE;

function loadOpenMode() {
	chrome.storage.sync.get(
		{
			[OPEN_MODE_STORAGE_KEY]: null,
			[ACTIVE_TAB_STORAGE_KEY]: DEFAULT_OPEN_IN_ACTIVE_TAB,
		},
		(items) => {
			openModeCache = resolveOpenMode(items);
		},
	);
}

loadOpenMode();

function buildTabOptions(url, active, sourceTab) {
	const tabOptions = { url, active };

	if (Number.isInteger(sourceTab?.index)) {
		tabOptions.index = sourceTab.index + 1;
	}

	return tabOptions;
}

function openInTab(url, sourceTab, sendResponse, active) {
	const tabOptions = buildTabOptions(url, active, sourceTab);

	chrome.tabs
		.create(tabOptions)
		.then((tab) => {
			// "Switch to it" must also pull the window forward, not just mark the tab
			// active — this is what the old single-checkbox path was missing.
			if (active && tab?.windowId != null) {
				chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
			}
			sendResponse?.({ ok: true });
		})
		.catch((error) => sendResponse?.({ ok: false, error: error.message }));
}

function openInSidePanel(url, label, sourceTab, sendResponse) {
	const tabId = sourceTab?.id;
	if (tabId == null || !chrome.sidePanel?.open) {
		openInTab(url, sourceTab, sendResponse, true);
		return;
	}

	// Open first (still inside the gesture), THEN stash the URL. The panel page
	// reads it from storage.session on load / via onChanged.
	const openPromise = chrome.sidePanel.open({ tabId });
	chrome.storage.session.set({
		[SIDE_PANEL_URL_KEY]: { url, label, ts: Date.now() },
	});

	openPromise
		.then(() => sendResponse?.({ ok: true }))
		.catch(() => openInTab(url, sourceTab, sendResponse, true));
}

// Routes a query URL by the active open mode. Frameable engines (OpenEvidence,
// UpToDate) use the side pane in side-pane mode; Google can't be iframed
// (X-Frame-Options: SAMEORIGIN), so it falls back to a focused tab.
function dispatchOpen(url, label, frameable, sourceTab, sendResponse) {
	if (openModeCache === OPEN_MODE_SIDE_PANE && frameable) {
		openInSidePanel(url, label, sourceTab, sendResponse);
		return;
	}

	// Background only in plain "new tab" mode; otherwise pull focus (this also
	// covers the side-pane fallback for non-frameable engines).
	openInTab(url, sourceTab, sendResponse, openModeCache !== OPEN_MODE_TAB_BG);
}

function openOpenEvidenceQuery(query, sourceTab, sendResponse, meta) {
	const nextQuery = typeof query === "string" ? query.trim() : "";
	if (!nextQuery) {
		sendResponse?.({ ok: false, error: "Empty query" });
		return;
	}

	const url = buildOpenEvidenceUrl(nextQuery);
	recordHistory({
		...(meta || { source: "selection" }),
		url,
		finalText: nextQuery,
	});
	dispatchOpen(url, "OpenEvidence", true, sourceTab, sendResponse);
}

function openUpToDateQuery(query, sourceTab, sendResponse) {
	const nextQuery = typeof query === "string" ? query.trim() : "";
	if (!nextQuery) {
		sendResponse?.({ ok: false, error: "Empty query" });
		return;
	}

	dispatchOpen(
		buildUpToDateUrl(nextQuery),
		"UpToDate",
		true,
		sourceTab,
		sendResponse,
	);
}

function openGoogleQuery(query, sourceTab, sendResponse) {
	const nextQuery = typeof query === "string" ? query.trim() : "";
	if (!nextQuery) {
		sendResponse?.({ ok: false, error: "Empty query" });
		return;
	}

	dispatchOpen(
		buildGoogleUrl(nextQuery),
		"Google",
		false,
		sourceTab,
		sendResponse,
	);
}

async function callGroq(apiKey, messages, options = {}) {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), GROQ_TIMEOUT_MS);
	const body = {
		model: GROQ_MODEL,
		messages:
			typeof messages === "string"
				? [{ role: "user", content: messages }]
				: messages,
		temperature: 0.2,
	};

	if (options.jsonMode) {
		body.response_format = { type: "json_object" };
	}

	try {
		const response = await fetch(
			"https://api.groq.com/openai/v1/chat/completions",
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(body),
				signal: controller.signal,
			},
		);

		const data = await response.json().catch(() => ({}));
		if (!response.ok) {
			const message =
				data?.error?.message ||
				`Groq request failed with HTTP ${response.status}`;
			throw new Error(message);
		}

		const content = data?.choices?.[0]?.message?.content?.trim();
		if (!content) {
			throw new Error("Groq returned an empty response");
		}

		return content;
	} catch (error) {
		if (error.name === "AbortError") {
			throw new Error("Groq request timed out");
		}

		throw error;
	} finally {
		clearTimeout(timeoutId);
	}
}

// ---------------------------------------------------------------- formulary

// The parsed list lives in storage.local; the keyword index is rebuilt lazily
// and dropped whenever a new list is imported or the list is cleared.
let formularyIndexPromise = null;

function getFormularyIndex() {
	if (!formularyIndexPromise) {
		formularyIndexPromise = chrome.storage.local
			.get({ [OEFormulary.FORMULARY_ITEMS_STORAGE_KEY]: [] })
			.then((items) =>
				OEFormulary.createIndex(items[OEFormulary.FORMULARY_ITEMS_STORAGE_KEY]),
			);
	}
	return formularyIndexPromise;
}

const ATC_GUESS_INSTRUCTION = `Identify the medications named in the text below (generic or brand names, any language). For each, give its generic name and its WHO ATC code at the most specific level you are confident of (prefer the 7-character code). Ignore anything that is not a medication.

Export as JSON:
{"drugs":[{"name":"empagliflozin","atc":"A10BK03"}]}
If there are none, export {"drugs":[]}.`;

// Asks Groq for ATC codes of drugs in the selection. Only used when nothing in
// the formulary matched by name, to still surface same-mechanism alternatives.
async function guessAtcCodes(apiKey, text) {
	const content = await callGroq(
		apiKey,
		`${ATC_GUESS_INSTRUCTION}\n\n+++text+++\n${text.slice(0, 2000)}`,
		{ jsonMode: true },
	);
	let parsed;
	try {
		parsed = JSON.parse(content);
	} catch (_error) {
		return [];
	}
	const drugs = Array.isArray(parsed?.drugs) ? parsed.drugs : [];
	return drugs
		.map((drug) => ({
			name: typeof drug?.name === "string" ? drug.name.trim().slice(0, 80) : "",
			atc: OEFormulary.normalizeAtc(drug?.atc),
		}))
		.filter((drug) => drug.name && drug.atc)
		.slice(0, 5);
}

async function lookupFormulary(query) {
	const text = typeof query === "string" ? query.trim() : "";
	if (!text) {
		throw new Error("Selection is required");
	}

	const index = await getFormularyIndex();
	if (index.items.length === 0) {
		throw new Error("尚未匯入院內品項，請先到設定頁的 Formulary 分頁匯入");
	}

	const result = OEFormulary.lookup(index, text);
	if (result.direct.length > 0) {
		return result;
	}

	const local = await chrome.storage.local.get({
		[GROQ_API_KEY_STORAGE_KEY]: "",
		[GROQ_VALIDATED_STORAGE_KEY]: false,
	});
	const apiKey = local[GROQ_API_KEY_STORAGE_KEY];
	if (!apiKey || local[GROQ_VALIDATED_STORAGE_KEY] !== true) {
		return { ...result, aiAvailable: false };
	}

	try {
		const guesses = await guessAtcCodes(apiKey, text);
		return {
			...result,
			aiAvailable: true,
			aiGuesses: guesses,
			...OEFormulary.lookupByAtc(
				index,
				guesses.map((guess) => guess.atc),
			),
		};
	} catch (error) {
		return { ...result, aiAvailable: true, aiError: error.message };
	}
}

function extractPicoQuestion(content) {
	const trimmed = typeof content === "string" ? content.trim() : "";
	if (!trimmed) {
		throw new Error("Groq returned an empty response");
	}

	try {
		const parsed = JSON.parse(trimmed);
		const question =
			typeof parsed.question === "string" ? parsed.question.trim() : "";
		if (question) {
			return question;
		}
	} catch (_error) {
		const match = trimmed.match(/"question"\s*:\s*"((?:\\.|[^"\\])*)"/);
		if (match) {
			const parsed = JSON.parse(`{"question":"${match[1]}"}`);
			const question = parsed.question.trim();
			if (question) {
				return question;
			}
		}
	}

	return trimmed;
}

chrome.runtime.onInstalled.addListener(async () => {
	const stored = await chrome.storage.sync.get([
		STORAGE_KEY,
		ACTIVE_TAB_STORAGE_KEY,
		OPEN_MODE_STORAGE_KEY,
		HISTORY_ENABLED_STORAGE_KEY,
	]);
	const defaults = {};

	if (!stored[STORAGE_KEY]) {
		defaults[STORAGE_KEY] = DEFAULT_WHITELIST;
	}

	// Seed the 3-way mode, migrating the legacy "open in active tab" boolean.
	if (
		stored[OPEN_MODE_STORAGE_KEY] !== OPEN_MODE_TAB_BG &&
		stored[OPEN_MODE_STORAGE_KEY] !== OPEN_MODE_TAB_ACTIVE &&
		stored[OPEN_MODE_STORAGE_KEY] !== OPEN_MODE_SIDE_PANE
	) {
		defaults[OPEN_MODE_STORAGE_KEY] = resolveOpenMode(stored);
	}

	// oeHistoryEnabled used to live in storage.local; migrate any existing
	// value into storage.sync so upgrading users keep their preference.
	if (typeof stored[HISTORY_ENABLED_STORAGE_KEY] !== "boolean") {
		const legacyLocal = await chrome.storage.local.get([
			HISTORY_ENABLED_STORAGE_KEY,
		]);
		if (typeof legacyLocal[HISTORY_ENABLED_STORAGE_KEY] === "boolean") {
			defaults[HISTORY_ENABLED_STORAGE_KEY] =
				legacyLocal[HISTORY_ENABLED_STORAGE_KEY];
		}
		await chrome.storage.local.remove([HISTORY_ENABLED_STORAGE_KEY]);
	}

	if (Object.keys(defaults).length > 0) {
		await chrome.storage.sync.set(defaults);
	}

	loadOpenMode();

	await chrome.contextMenus.removeAll();
	chrome.contextMenus.create({
		id: ASK_CONTEXT_MENU_ID,
		title: "Ask OpenEvidence",
		contexts: ["selection"],
	});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
	if (message?.type === "OE_OPEN_QUERY") {
		openOpenEvidenceQuery(
			message.query,
			sender.tab,
			sendResponse,
			message.meta,
		);
		return true;
	}

	if (message?.type === "OE_OPEN_UPTODATE") {
		openUpToDateQuery(message.query, sender.tab, sendResponse);
		return true;
	}

	if (message?.type === "OE_OPEN_GOOGLE") {
		openGoogleQuery(message.query, sender.tab, sendResponse);
		return true;
	}

	// Sent by src/nccn-redirect.js when a rewritten NCCN link is clicked. It
	// comes from the OpenEvidence tab or from the OE iframe inside the side
	// panel; the latter has no sender.tab, so the new tab just lands at the end
	// of the strip. The service worker opens it because a content script has no
	// chrome.tabs, and because a page can't navigate itself to a file:// URL.
	if (message?.type === "OE_OPEN_URL") {
		const url = typeof message.url === "string" ? message.url.trim() : "";
		if (!url) {
			sendResponse({ ok: false, error: "Empty URL" });
			return false;
		}

		openInTab(url, sender.tab, sendResponse, true);
		return true;
	}

	if (message?.type === "OE_FORMULARY_LOOKUP") {
		lookupFormulary(message.query)
			.then((result) => sendResponse({ ok: true, result }))
			.catch((error) => sendResponse({ ok: false, error: error.message }));
		return true;
	}

	if (message?.type === "OE_VALIDATE_GROQ_KEY") {
		const apiKey =
			typeof message.apiKey === "string" ? message.apiKey.trim() : "";
		if (!apiKey) {
			sendResponse({ ok: false, error: "API key is required" });
			return false;
		}

		callGroq(apiKey, "Reply with exactly: ok")
			.then(async () => {
				await chrome.storage.local.set({
					[GROQ_API_KEY_STORAGE_KEY]: apiKey,
					[GROQ_VALIDATED_STORAGE_KEY]: true,
				});
				sendResponse({ ok: true });
			})
			.catch(async (error) => {
				await chrome.storage.local.set({ [GROQ_VALIDATED_STORAGE_KEY]: false });
				sendResponse({ ok: false, error: error.message });
			});

		return true;
	}

	if (message?.type === "OE_CLEAR_GROQ_KEY") {
		chrome.storage.local
			.remove([GROQ_API_KEY_STORAGE_KEY, GROQ_VALIDATED_STORAGE_KEY])
			.then(() => sendResponse({ ok: true }))
			.catch((error) => sendResponse({ ok: false, error: error.message }));

		return true;
	}

	if (message?.type === "OE_GENERATE_PICO") {
		const selection =
			typeof message.selection === "string" ? message.selection.trim() : "";
		if (!selection) {
			sendResponse({ ok: false, error: "Selection is required" });
			return false;
		}

		chrome.storage.local.get(
			{
				[GROQ_API_KEY_STORAGE_KEY]: "",
				[GROQ_VALIDATED_STORAGE_KEY]: false,
			},
			(items) => {
				const apiKey = items[GROQ_API_KEY_STORAGE_KEY];
				const validated = items[GROQ_VALIDATED_STORAGE_KEY] === true;

				if (!apiKey || !validated) {
					sendResponse({
						ok: false,
						error: "Validate a Groq API key in extension options first",
					});
					return;
				}

				const prompt = `${PICO_INSTRUCTION}\n\n+++user selection+++\n${selection}`;
				callGroq(apiKey, prompt, { jsonMode: true })
					.then((content) =>
						sendResponse({
							ok: true,
							content: extractPicoQuestion(content),
							prompt: PICO_INSTRUCTION,
						}),
					)
					.catch((error) => sendResponse({ ok: false, error: error.message }));
			},
		);

		return true;
	}

	if (message?.type === "OE_GENERATE_CUSTOM_PROMPT") {
		const selection =
			typeof message.selection === "string" ? message.selection.trim() : "";
		const prompt =
			typeof message.prompt === "string" ? message.prompt.trim() : "";
		if (!selection || !prompt) {
			sendResponse({ ok: false, error: "Selection and prompt are required" });
			return false;
		}

		chrome.storage.local.get(
			{
				[GROQ_API_KEY_STORAGE_KEY]: "",
				[GROQ_VALIDATED_STORAGE_KEY]: false,
			},
			(items) => {
				const apiKey = items[GROQ_API_KEY_STORAGE_KEY];
				const validated = items[GROQ_VALIDATED_STORAGE_KEY] === true;

				if (!apiKey || !validated) {
					sendResponse({
						ok: false,
						error: "Validate a Groq API key in extension options first",
					});
					return;
				}

				const fullPrompt = `${selection}\n\n${prompt}`;
				callGroq(apiKey, fullPrompt)
					.then((content) =>
						sendResponse({ ok: true, content: content.trim(), prompt }),
					)
					.catch((error) => sendResponse({ ok: false, error: error.message }));
			},
		);

		return true;
	}

	return false;
});

chrome.storage.onChanged.addListener((changes, areaName) => {
	if (
		areaName === "local" &&
		changes[OEFormulary.FORMULARY_ITEMS_STORAGE_KEY]
	) {
		formularyIndexPromise = null;
		return;
	}

	if (areaName !== "sync") {
		return;
	}

	if (changes[OPEN_MODE_STORAGE_KEY] || changes[ACTIVE_TAB_STORAGE_KEY]) {
		loadOpenMode();
	}
});

chrome.action.onClicked.addListener(() => {
	chrome.runtime.openOptionsPage();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
	if (info.menuItemId !== ASK_CONTEXT_MENU_ID) {
		return;
	}

	openOpenEvidenceQuery(info.selectionText, tab, undefined, {
		source: "context-menu",
	});
});
