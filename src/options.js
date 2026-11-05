const STORAGE_KEY = "oeWhitelist";
const ACTIVE_TAB_STORAGE_KEY = "oeOpenInActiveTab";
const OPEN_MODE_STORAGE_KEY = "oeOpenMode";
const OPEN_MODES = ["tab-bg", "tab-active", "side-pane"];
const DEFAULT_OPEN_MODE = "tab-bg";
const CUSTOM_PROMPTS_STORAGE_KEY = "oeCustomPrompts";
const THEME_STORAGE_KEY = "oeTheme";
const GROQ_API_KEY_STORAGE_KEY = "oeGroqApiKey";
const GROQ_VALIDATED_STORAGE_KEY = "oeGroqApiKeyValidated";
const HISTORY_STORAGE_KEY = "oeHistory";
const HISTORY_ENABLED_STORAGE_KEY = "oeHistoryEnabled";
const DEFAULT_HISTORY_ENABLED = true;
const NCCN_ENABLED_STORAGE_KEY = "oeNccnRedirectEnabled";
const NCCN_TEMPLATE_STORAGE_KEY = "oeNccnUrlTemplate";
const DEFAULT_NCCN_ENABLED = true;
const DEFAULT_NCCN_TEMPLATE =
	"https://nccn.hsiehting.com/preview/$cancer?page=$page";
const DEFAULT_WHITELIST = [
	"https://ankiuser.net/study",
	"https://www.openevidence.com/*",
	"http://uptodate.com/*",
	"nejm.org/*",
	"https://accessmedicine.mhmedical.com/*",
	"https://www.clinicalkey.com/*",
	"file:///*",
];
const DEFAULT_OPEN_IN_ACTIVE_TAB = false;
const DEFAULT_THEME = "system";

const form = document.querySelector("#options-form");
const textarea = document.querySelector("#whitelist");
const openModeSelect = document.querySelector("#open-mode");
const themeSelect = document.querySelector("#theme");
const groqApiKeyInput = document.querySelector("#groq-api-key");
const editGroqKeyButton = document.querySelector("#edit-groq-key");
const saveGroqKeyButton = document.querySelector("#save-groq-key");
const clearGroqKeyButton = document.querySelector("#clear-groq-key");
const customPromptsContainer = document.querySelector("#custom-prompts");
const addCustomPromptButton = document.querySelector("#add-custom-prompt");
const groqStatus = document.querySelector("#groq-status");
const resetButton = document.querySelector("#reset");
const status = document.querySelector("#status");
const recordHistoryCheckbox = document.querySelector("#record-history");
const nccnEnabledCheckbox = document.querySelector("#nccn-enabled");
const nccnTemplateInput = document.querySelector("#nccn-template");
const tabButtons = Array.from(document.querySelectorAll(".tab-button"));
const optionsForm = document.querySelector("#options-form");
const settingsPanel = document.querySelector("#tab-settings");
const promptsPanel = document.querySelector("#tab-prompts");
const historyPanel = document.querySelector("#tab-history");
const historyList = document.querySelector("#history-list");
const historyEmpty = document.querySelector("#history-empty");
const clearHistoryButton = document.querySelector("#clear-history");
const formularyPanel = document.querySelector("#tab-formulary");
const formularyFileInput = document.querySelector("#formulary-file");
const clearFormularyButton = document.querySelector("#clear-formulary");
const formularyStatus = document.querySelector("#formulary-status");
const formularyQueryInput = document.querySelector("#formulary-query");
const formularyResults = document.querySelector("#formulary-results");
const rxclassEnabledCheckbox = document.querySelector("#rxclass-enabled");
const RXCLASS_ENABLED_STORAGE_KEY = "oeRxClassEnabled";
const DEFAULT_RXCLASS_ENABLED = true;

function createLucideIcon(name) {
	const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
	svg.setAttribute("class", "options-lucide-icon");
	svg.setAttribute("viewBox", "0 0 24 24");
	svg.setAttribute("fill", "none");
	svg.setAttribute("stroke", "currentColor");
	svg.setAttribute("stroke-width", "2");
	svg.setAttribute("stroke-linecap", "round");
	svg.setAttribute("stroke-linejoin", "round");
	svg.setAttribute("aria-hidden", "true");

	const paths = {
		edit: [
			'<path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>',
			'<path d="M18.4 2.6a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4Z"/>',
		],
		plus: ['<path d="M5 12h14"/>', '<path d="M12 5v14"/>'],
		save: [
			'<path d="M15.2 3a2 2 0 0 1 1.4.6l2.8 2.8A2 2 0 0 1 20 7.8V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/>',
			'<path d="M17 21v-8H7v8"/>',
			'<path d="M7 3v5h8"/>',
		],
		trash: [
			'<path d="M3 6h18"/>',
			'<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/>',
			'<path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
		],
		x: ['<path d="M18 6 6 18"/>', '<path d="m6 6 12 12"/>'],
	};

	svg.innerHTML = paths[name]?.join("") || paths.plus.join("");
	return svg;
}

function setButtonIcon(button, iconName) {
	if (!button || button.dataset.iconApplied === "true") {
		return;
	}

	const label = document.createElement("span");
	label.textContent = button.textContent;
	button.textContent = "";
	button.append(createLucideIcon(iconName), label);
	button.dataset.iconApplied = "true";
}

function parseWhitelist(value) {
	return value
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
}

function setStatus(message) {
	status.textContent = message;
	window.setTimeout(() => {
		status.textContent = "";
	}, 2500);
}

function setGroqStatus(message, state = "") {
	groqStatus.textContent = message;
	groqStatus.dataset.state = state;
}

function setGroqKeyEditing(isEditing) {
	groqApiKeyInput.readOnly = !isEditing;
	saveGroqKeyButton.disabled = !isEditing;
	editGroqKeyButton.disabled = isEditing;

	if (isEditing) {
		groqApiKeyInput.focus();
		groqApiKeyInput.select();
	}
}

function normalizeTheme(value) {
	return ["system", "light", "dark"].includes(value) ? value : DEFAULT_THEME;
}

function resolveOpenMode(items) {
	const mode = items[OPEN_MODE_STORAGE_KEY];
	if (OPEN_MODES.includes(mode)) {
		return mode;
	}

	// Migrate the legacy "open in active tab" boolean.
	return items[ACTIVE_TAB_STORAGE_KEY] === true
		? "tab-active"
		: DEFAULT_OPEN_MODE;
}

function applyOptionsTheme(value) {
	const theme = normalizeTheme(value);
	const resolvedTheme =
		theme === "system" &&
		window.matchMedia?.("(prefers-color-scheme: dark)").matches
			? "dark"
			: theme;
	document.documentElement.dataset.theme =
		resolvedTheme === "dark" ? "dark" : "light";
}

function normalizeCustomPrompts(value) {
	if (!Array.isArray(value)) {
		return [];
	}

	return value
		.map((item) => ({
			name: typeof item?.name === "string" ? item.name.trim() : "",
			prompt: typeof item?.prompt === "string" ? item.prompt.trim() : "",
		}))
		.filter((item) => item.name && item.prompt)
		.slice(0, 6);
}

function createCustomPromptRow(item = { name: "", prompt: "" }) {
	const row = document.createElement("div");
	row.className = "custom-prompt-row";

	const nameLabel = document.createElement("label");
	nameLabel.textContent = "Button name";

	const nameInput = document.createElement("input");
	nameInput.type = "text";
	nameInput.className = "custom-prompt-row__name";
	nameInput.autocomplete = "off";
	nameInput.spellcheck = false;
	nameInput.value = item.name;

	const promptLabel = document.createElement("label");
	promptLabel.textContent = "Prompt";

	const promptInput = document.createElement("textarea");
	promptInput.className = "custom-prompt-row__prompt";
	promptInput.rows = 4;
	promptInput.spellcheck = false;
	promptInput.value = item.prompt;

	const removeButton = document.createElement("button");
	removeButton.type = "button";
	removeButton.textContent = "Remove";
	setButtonIcon(removeButton, "trash");
	removeButton.addEventListener("click", () => {
		row.remove();
	});

	row.append(nameLabel, nameInput, promptLabel, promptInput, removeButton);
	customPromptsContainer.appendChild(row);
}

function getCustomPromptRows() {
	return normalizeCustomPrompts(
		Array.from(
			customPromptsContainer.querySelectorAll(".custom-prompt-row"),
		).map((row) => ({
			name: row.querySelector(".custom-prompt-row__name")?.value || "",
			prompt: row.querySelector(".custom-prompt-row__prompt")?.value || "",
		})),
	);
}

// A blank template would silently disable the redirect, so fall back to the
// default instead of storing nothing.
function normalizeNccnTemplate(value) {
	return typeof value === "string" && value.trim()
		? value.trim()
		: DEFAULT_NCCN_TEMPLATE;
}

async function loadOptions() {
	const items = await chrome.storage.sync.get({
		[STORAGE_KEY]: DEFAULT_WHITELIST,
		[ACTIVE_TAB_STORAGE_KEY]: DEFAULT_OPEN_IN_ACTIVE_TAB,
		[OPEN_MODE_STORAGE_KEY]: null,
		[CUSTOM_PROMPTS_STORAGE_KEY]: [],
		[THEME_STORAGE_KEY]: DEFAULT_THEME,
		[HISTORY_ENABLED_STORAGE_KEY]: DEFAULT_HISTORY_ENABLED,
		[NCCN_ENABLED_STORAGE_KEY]: DEFAULT_NCCN_ENABLED,
		[NCCN_TEMPLATE_STORAGE_KEY]: DEFAULT_NCCN_TEMPLATE,
	});
	const whitelist = Array.isArray(items[STORAGE_KEY])
		? items[STORAGE_KEY]
		: DEFAULT_WHITELIST;
	textarea.value = whitelist.join("\n");
	openModeSelect.value = resolveOpenMode(items);
	themeSelect.value = normalizeTheme(items[THEME_STORAGE_KEY]);
	applyOptionsTheme(themeSelect.value);
	customPromptsContainer.textContent = "";
	normalizeCustomPrompts(items[CUSTOM_PROMPTS_STORAGE_KEY]).forEach(
		createCustomPromptRow,
	);
	recordHistoryCheckbox.checked = items[HISTORY_ENABLED_STORAGE_KEY] !== false;
	nccnEnabledCheckbox.checked = items[NCCN_ENABLED_STORAGE_KEY] !== false;
	nccnTemplateInput.value = normalizeNccnTemplate(
		items[NCCN_TEMPLATE_STORAGE_KEY],
	);

	const localItems = await chrome.storage.local.get({
		[GROQ_API_KEY_STORAGE_KEY]: "",
		[GROQ_VALIDATED_STORAGE_KEY]: false,
	});
	groqApiKeyInput.value = localItems[GROQ_API_KEY_STORAGE_KEY] || "";
	const hasValidatedKey =
		localItems[GROQ_VALIDATED_STORAGE_KEY] === true &&
		Boolean(groqApiKeyInput.value);
	setGroqStatus(
		hasValidatedKey ? "Groq API key validated." : "No validated Groq API key.",
		hasValidatedKey ? "success" : "",
	);
	setGroqKeyEditing(!groqApiKeyInput.value);
}

form.addEventListener("submit", async (event) => {
	event.preventDefault();

	const whitelist = parseWhitelist(textarea.value);
	const customPrompts = getCustomPromptRows();

	const openMode = OPEN_MODES.includes(openModeSelect.value)
		? openModeSelect.value
		: DEFAULT_OPEN_MODE;

	await chrome.storage.sync.set({
		[STORAGE_KEY]: whitelist.length > 0 ? whitelist : DEFAULT_WHITELIST,
		[OPEN_MODE_STORAGE_KEY]: openMode,
		[ACTIVE_TAB_STORAGE_KEY]: openMode === "tab-active",
		[CUSTOM_PROMPTS_STORAGE_KEY]: customPrompts,
		[THEME_STORAGE_KEY]: normalizeTheme(themeSelect.value),
		[NCCN_ENABLED_STORAGE_KEY]: nccnEnabledCheckbox.checked,
		[NCCN_TEMPLATE_STORAGE_KEY]: normalizeNccnTemplate(nccnTemplateInput.value),
	});
	textarea.value = (whitelist.length > 0 ? whitelist : DEFAULT_WHITELIST).join(
		"\n",
	);
	nccnTemplateInput.value = normalizeNccnTemplate(nccnTemplateInput.value);
	setStatus("Saved.");
});

resetButton.addEventListener("click", async () => {
	await chrome.storage.sync.set({
		[STORAGE_KEY]: DEFAULT_WHITELIST,
		[OPEN_MODE_STORAGE_KEY]: DEFAULT_OPEN_MODE,
		[ACTIVE_TAB_STORAGE_KEY]: DEFAULT_OPEN_IN_ACTIVE_TAB,
		[CUSTOM_PROMPTS_STORAGE_KEY]: [],
		[THEME_STORAGE_KEY]: DEFAULT_THEME,
		[NCCN_ENABLED_STORAGE_KEY]: DEFAULT_NCCN_ENABLED,
		[NCCN_TEMPLATE_STORAGE_KEY]: DEFAULT_NCCN_TEMPLATE,
	});
	textarea.value = DEFAULT_WHITELIST.join("\n");
	nccnEnabledCheckbox.checked = DEFAULT_NCCN_ENABLED;
	nccnTemplateInput.value = DEFAULT_NCCN_TEMPLATE;
	openModeSelect.value = DEFAULT_OPEN_MODE;
	themeSelect.value = DEFAULT_THEME;
	applyOptionsTheme(DEFAULT_THEME);
	customPromptsContainer.textContent = "";
	setStatus("Reset.");
});

addCustomPromptButton.addEventListener("click", () => {
	if (
		customPromptsContainer.querySelectorAll(".custom-prompt-row").length >= 6
	) {
		setStatus("Custom prompt limit is 6.");
		return;
	}

	createCustomPromptRow();
});

editGroqKeyButton.addEventListener("click", () => {
	setGroqKeyEditing(true);
});

saveGroqKeyButton.addEventListener("click", () => {
	const apiKey = groqApiKeyInput.value.trim();
	setGroqStatus("Validating Groq API key...");
	saveGroqKeyButton.disabled = true;

	chrome.runtime.sendMessage(
		{ type: "OE_VALIDATE_GROQ_KEY", apiKey },
		(response) => {
			if (!response?.ok) {
				saveGroqKeyButton.disabled = false;
				setGroqStatus(
					response?.error || "Groq API key validation failed.",
					"error",
				);
				return;
			}

			setGroqStatus("Groq API key validated and saved locally.", "success");
			setGroqKeyEditing(false);
		},
	);
});

clearGroqKeyButton.addEventListener("click", () => {
	chrome.runtime.sendMessage({ type: "OE_CLEAR_GROQ_KEY" }, (response) => {
		if (!response?.ok) {
			setGroqStatus(response?.error || "Unable to clear Groq API key.");
			return;
		}

		groqApiKeyInput.value = "";
		setGroqStatus("Groq API key cleared.");
		setGroqKeyEditing(true);
	});
});

themeSelect.addEventListener("change", () => {
	applyOptionsTheme(themeSelect.value);
});

recordHistoryCheckbox.addEventListener("change", () => {
	chrome.storage.sync.set({
		[HISTORY_ENABLED_STORAGE_KEY]: recordHistoryCheckbox.checked,
	});
	setStatus(
		recordHistoryCheckbox.checked
			? "History recording on."
			: "History recording off.",
	);
});

function activateTab(name) {
	tabButtons.forEach((button) => {
		const isActive = button.dataset.tab === name;
		button.classList.toggle("is-active", isActive);
		button.setAttribute("aria-selected", isActive ? "true" : "false");
	});

	optionsForm.hidden = name === "history" || name === "formulary";
	settingsPanel.hidden = name !== "settings";
	promptsPanel.hidden = name !== "prompts";
	historyPanel.hidden = name !== "history";
	formularyPanel.hidden = name !== "formulary";

	if (name === "history") {
		loadHistory();
	}
	if (name === "formulary") {
		loadFormularyStatus();
	}
}

tabButtons.forEach((button) => {
	button.addEventListener("click", () => activateTab(button.dataset.tab));
});

function formatTimestamp(timestamp) {
	if (!Number.isFinite(timestamp)) {
		return "";
	}
	try {
		return new Date(timestamp).toLocaleString();
	} catch (_error) {
		return "";
	}
}

function createHistoryDetail(label, value) {
	const wrapper = document.createElement("div");
	wrapper.className = "history-detail";

	const term = document.createElement("span");
	term.className = "history-detail__label";
	term.textContent = label;

	const body = document.createElement("p");
	body.className = "history-detail__value";
	body.textContent = value;

	wrapper.append(term, body);
	return wrapper;
}

function createHistoryItem(entry) {
	const item = document.createElement("article");
	item.className = "history-item";

	const head = document.createElement("div");
	head.className = "history-item__head";

	const source = document.createElement("span");
	source.className = "history-source";
	source.dataset.source = entry.source || "selection";
	source.textContent = entry.source || "selection";

	const meta = document.createElement("span");
	meta.className = "history-meta";
	meta.textContent = formatTimestamp(entry.timestamp);

	const deleteButton = document.createElement("button");
	deleteButton.type = "button";
	deleteButton.className = "history-delete";
	deleteButton.title = "Delete entry";
	deleteButton.setAttribute("aria-label", "Delete entry");
	deleteButton.append(createLucideIcon("x"));
	deleteButton.addEventListener("click", () => deleteHistoryEntry(entry.id));

	head.append(source, meta, deleteButton);

	const finalText = document.createElement("p");
	finalText.className = "history-final";
	finalText.textContent = entry.finalText || "";

	item.append(head, finalText);

	if (entry.url) {
		const link = document.createElement("a");
		link.className = "history-open";
		link.href = entry.url;
		link.target = "_blank";
		link.rel = "noopener noreferrer";
		link.textContent = "Open in OpenEvidence";
		item.append(link);
	}

	if (entry.original || entry.promptInstruction || entry.transformed) {
		const details = document.createElement("details");
		details.className = "history-transform";

		const summary = document.createElement("summary");
		summary.textContent = entry.promptName
			? `Transform · ${entry.promptName}`
			: "Transform details";
		details.append(summary);

		if (entry.original) {
			details.append(createHistoryDetail("Original selection", entry.original));
		}
		if (entry.promptInstruction) {
			details.append(createHistoryDetail("Prompt", entry.promptInstruction));
		}
		if (entry.transformed) {
			details.append(
				createHistoryDetail("Transformed output", entry.transformed),
			);
		}

		item.append(details);
	}

	return item;
}

async function loadHistory() {
	const items = await chrome.storage.local.get({ [HISTORY_STORAGE_KEY]: [] });
	const history = Array.isArray(items[HISTORY_STORAGE_KEY])
		? items[HISTORY_STORAGE_KEY]
		: [];

	historyList.textContent = "";
	historyEmpty.hidden = history.length > 0;

	history.forEach((entry) => {
		historyList.appendChild(createHistoryItem(entry));
	});
}

async function deleteHistoryEntry(id) {
	const items = await chrome.storage.local.get({ [HISTORY_STORAGE_KEY]: [] });
	const history = Array.isArray(items[HISTORY_STORAGE_KEY])
		? items[HISTORY_STORAGE_KEY]
		: [];
	const next = history.filter((entry) => entry.id !== id);
	await chrome.storage.local.set({ [HISTORY_STORAGE_KEY]: next });
	loadHistory();
}

clearHistoryButton.addEventListener("click", async () => {
	await chrome.storage.local.set({ [HISTORY_STORAGE_KEY]: [] });
	loadHistory();
});

// ---------------------------------------------------------------- formulary

const FIELD_LABELS = {
	code: "批價碼",
	atc: "ATC碼",
	pharm: "藥理代碼",
	form: "劑型",
	nhiPrice: "健保價",
	selfPrice: "自費價",
};
let formularyIndex = null;

function setFormularyStatus(message, state = "") {
	formularyStatus.textContent = message;
	formularyStatus.dataset.state = state;
}

function describeFormularyMeta(meta) {
	if (!meta?.count) {
		return "尚未匯入院內品項。";
	}
	const when = meta.importedAt ? formatTimestamp(meta.importedAt) : "";
	let text = `已匯入 ${meta.count} 項（${meta.withAtc ?? 0} 項有 ATC 碼）`;
	if (meta.fileName) {
		text += ` · ${meta.fileName}`;
	}
	if (when) {
		text += ` · ${when}`;
	}
	if (Array.isArray(meta.missingColumns) && meta.missingColumns.length > 0) {
		const missing = meta.missingColumns
			.map((field) => FIELD_LABELS[field])
			.filter(Boolean);
		if (missing.length > 0) {
			text += `。找不到欄位：${missing.join("、")}`;
		}
	}
	return text;
}

async function loadFormularyStatus() {
	const stored = await chrome.storage.local.get({
		[OEFormulary.FORMULARY_ITEMS_STORAGE_KEY]: [],
		[OEFormulary.FORMULARY_META_STORAGE_KEY]: null,
	});
	const meta = stored[OEFormulary.FORMULARY_META_STORAGE_KEY];
	formularyIndex = OEFormulary.createIndex(
		stored[OEFormulary.FORMULARY_ITEMS_STORAGE_KEY],
	);
	setFormularyStatus(describeFormularyMeta(meta), meta?.count ? "success" : "");
	const syncItems = await chrome.storage.sync.get({
		[RXCLASS_ENABLED_STORAGE_KEY]: DEFAULT_RXCLASS_ENABLED,
	});
	rxclassEnabledCheckbox.checked =
		syncItems[RXCLASS_ENABLED_STORAGE_KEY] !== false;
	clearFormularyButton.disabled = !meta?.count;
	renderFormularyTest();
}

function createFormularyResultGroup(title, items) {
	const group = document.createElement("div");
	group.className = "formulary-group";
	const heading = document.createElement("h3");
	heading.textContent = `${title}（${items.length}）`;
	const list = document.createElement("ul");
	items.forEach((item) => {
		const row = document.createElement("li");
		const name = document.createElement("span");
		name.className = "formulary-name";
		name.textContent = item.name;
		const meta = document.createElement("span");
		meta.className = "formulary-meta";
		meta.textContent = [
			item.code,
			item.atc && `ATC ${item.atc}`,
			item.form && OEFormulary.formLabel(item.form),
		]
			.filter(Boolean)
			.join(" · ");
		row.append(name, meta);
		list.append(row);
	});
	group.append(heading, list);
	return group;
}

function renderFormularyTest() {
	formularyResults.textContent = "";
	const query = formularyQueryInput.value.trim();
	if (!query || !formularyIndex?.items.length) {
		return;
	}

	const result = OEFormulary.lookup(formularyIndex, query);
	if (result.direct.length === 0) {
		const empty = document.createElement("p");
		empty.textContent =
			"院內沒有符合的品項。（這裡只查院內清單；在網頁上使用「院內」按鈕時，會再依序查 NLM RxClass 與 Groq AI 找同機轉品項。）";
		formularyResults.append(empty);
		return;
	}

	formularyResults.append(
		createFormularyResultGroup("院內有此藥", result.direct),
	);
	if (result.sameIngredient.length > 0) {
		formularyResults.append(
			createFormularyResultGroup("同成分其他品項", result.sameIngredient),
		);
	}
	result.classes.forEach((group) => {
		formularyResults.append(
			createFormularyResultGroup(`同機轉 · ATC ${group.atcClass}`, group.items),
		);
	});
}

formularyFileInput.addEventListener("change", async () => {
	const file = formularyFileInput.files?.[0];
	if (!file) {
		return;
	}

	setFormularyStatus(`正在讀取 ${file.name}…`);
	try {
		const parsed = await OEFormulary.parseFormularyFile(
			file.name,
			await file.arrayBuffer(),
		);
		if (parsed.items.length === 0) {
			throw new Error("檔案裡沒有任何品項");
		}
		await chrome.storage.local.set({
			[OEFormulary.FORMULARY_ITEMS_STORAGE_KEY]: parsed.items,
			[OEFormulary.FORMULARY_META_STORAGE_KEY]: {
				count: parsed.items.length,
				withAtc: parsed.withAtc,
				missingColumns: parsed.missingColumns,
				fileName: file.name,
				importedAt: Date.now(),
			},
		});
		await loadFormularyStatus();
	} catch (error) {
		setFormularyStatus(`匯入失敗：${error.message}`, "error");
	} finally {
		formularyFileInput.value = "";
	}
});

clearFormularyButton.addEventListener("click", async () => {
	await chrome.storage.local.remove([
		OEFormulary.FORMULARY_ITEMS_STORAGE_KEY,
		OEFormulary.FORMULARY_META_STORAGE_KEY,
	]);
	await loadFormularyStatus();
});

formularyQueryInput.addEventListener("input", renderFormularyTest);

rxclassEnabledCheckbox.addEventListener("change", () => {
	chrome.storage.sync.set({
		[RXCLASS_ENABLED_STORAGE_KEY]: rxclassEnabledCheckbox.checked,
	});
});

window
	.matchMedia?.("(prefers-color-scheme: dark)")
	.addEventListener("change", () => {
		if (themeSelect.value === "system") {
			applyOptionsTheme("system");
		}
	});

loadOptions();

setButtonIcon(editGroqKeyButton, "edit");
setButtonIcon(saveGroqKeyButton, "save");
setButtonIcon(clearGroqKeyButton, "trash");
setButtonIcon(addCustomPromptButton, "plus");
setButtonIcon(form.querySelector('button[type="submit"]'), "save");
setButtonIcon(resetButton, "x");
setButtonIcon(clearHistoryButton, "trash");
setButtonIcon(clearFormularyButton, "trash");
