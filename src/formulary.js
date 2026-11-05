// Hospital formulary (院內品項) lookup: parse an exported drug list (CSV or
// XLSX), match a selection against it, and list in-house drugs that share the
// same ingredient (identical 7-character ATC) or the same mechanism (same
// 5-character ATC chemical subgroup, e.g. C10AA = statins).
//
// Loaded as a classic script in three places — the service worker
// (importScripts), the options page (<script>), and the Node tests (vm) — so
// everything is kept off the global scope except `OEFormulary`.

(function (root) {
	const FORMULARY_ITEMS_STORAGE_KEY = "oeFormularyItems";
	const FORMULARY_META_STORAGE_KEY = "oeFormularyMeta";
	// The shared list's address (a published Google Sheets CSV link).
	const FORMULARY_URL_STORAGE_KEY = "oeFormularyUrl";

	// Header aliases, compared after removing whitespace and lower-casing.
	const COLUMN_ALIASES = {
		code: ["批價碼", "院內代碼", "藥品代碼", "藥碼", "代碼", "code"],
		name: ["藥名", "品名", "藥品名稱", "藥品名", "name", "drugname"],
		atc: ["atc碼", "atc", "atccode"],
		pharm: ["藥理代碼", "藥理分類", "藥理"],
		form: ["劑型", "form"],
		nhiPrice: ["健保價", "健保價格"],
		selfPrice: ["自費價", "自費價格"],
	};
	// Any header containing one of these is a storage location (P1儲位, 藥庫…).
	const LOCATION_HEADER_PATTERN = /儲位|藥庫|location/i;

	const FORM_LABELS = { O: "口服", I: "注射", E: "外用" };

	// Valid WHO ATC prefixes: anatomical group A–V, then digits/letters by level.
	// Pseudo codes such as "XCOVID0" fail this and are ignored for grouping.
	const ATC_PATTERN = /^[A-V]\d{2}(?:[A-Z](?:[A-Z](?:\d{2})?)?)?$/;

	// Words in drug names that say nothing about the drug itself.
	const STOP_WORDS = new Set(
		(
			"tab tabs tablet tablets cap caps capsule capsules amp amps vial vials " +
			"bot bott bottle tube box bag bags pack patch puff puffs dose doses " +
			"soln solution susp suspension syrup inj injection infusion oral " +
			"cream oint ointment lotion drop drops gel spray nasal film coated " +
			"with and for the plus human generic premix prefilled syringe pen " +
			"irrigation dual chamber unit units gram gm mcg tube sachet powder " +
			"extended release sustained delayed enteric chewable granules eye ophth " +
			"oph topical vaginal rectal supp suppository sterile water"
		).split(/\s+/),
	);
	const CJK_STOP_WORDS = new Set([
		"抗癌藥",
		"抗癌",
		"學名藥",
		"公費",
		"生物相似",
		"心血管用藥",
		"注射液",
		"眼藥水",
		"軟膏",
		"雙聯袋",
		"沖洗用",
	]);
	const MIN_LATIN_KEYWORD = 4;
	const MIN_CJK_KEYWORD = 2;
	// A match must reach this fraction of the best score to be listed, so a
	// shared word ("calcium", "acid") can't drag in unrelated items.
	const RELATIVE_SCORE_THRESHOLD = 0.5;
	const DEFAULT_LIMITS = { direct: 20, sameIngredient: 20, perClass: 25 };

	// Common English words in clinical prose that are never drug names; skipped
	// so a selected sentence doesn't fan out into pointless RxClass requests.
	const RXCLASS_TERM_STOP_WORDS = new Set(
		(
			"patient patients with without after before during daily dose doses " +
			"dosing therapy treatment treated mortality reduce reduced reduces " +
			"increase increased risk compared versus than that this these those " +
			"were was have has had from into over under about among trial trials " +
			"study studies group groups placebo randomized year years month months " +
			"week weeks days hospitalization failure heart disease events event " +
			"outcome outcomes adverse effect effects whereas while which when where " +
			"what also more less most least should could would there their other " +
			"such than then them they given use used using combination plus initial " +
			"first line second therapy acute chronic severe mild moderate associated " +
			"evidence guideline guidelines recommended recommend benefit benefits"
		).split(/\s+/),
	);
	const MAX_RXCLASS_TERMS = 8;

	function cleanCell(value) {
		if (value === null || value === undefined) {
			return "";
		}
		return String(value).replace(/\s+/g, " ").trim();
	}

	function normalizeHeader(value) {
		return cleanCell(value).replace(/\s+/g, "").toLowerCase();
	}

	function normalizeAtc(value) {
		const atc = cleanCell(value).toUpperCase().replace(/\s+/g, "");
		return ATC_PATTERN.test(atc) ? atc : "";
	}

	// The level-4 chemical subgroup (5 chars) shared by drugs with the same
	// mechanism. A bare level-4 code is its own class; anything shorter is too
	// broad to call "same mechanism".
	function atcClassOf(atc) {
		const normalized = normalizeAtc(atc);
		return normalized.length >= 5 ? normalized.slice(0, 5) : "";
	}

	function formLabel(form) {
		const key = cleanCell(form).toUpperCase();
		return FORM_LABELS[key] || key;
	}

	// ---------------------------------------------------------------- parsing

	// RFC 4180-ish CSV: quoted fields, doubled quotes, CRLF/LF, embedded newlines.
	function parseCsv(text) {
		const source = String(text || "").replace(/^﻿/, "");
		const rows = [];
		let row = [];
		let field = "";
		let quoted = false;

		for (let i = 0; i < source.length; i += 1) {
			const char = source[i];
			if (quoted) {
				if (char === '"') {
					if (source[i + 1] === '"') {
						field += '"';
						i += 1;
					} else {
						quoted = false;
					}
				} else {
					field += char;
				}
				continue;
			}

			if (char === '"') {
				quoted = true;
			} else if (char === ",") {
				row.push(field);
				field = "";
			} else if (char === "\n" || char === "\r") {
				if (char === "\r" && source[i + 1] === "\n") {
					i += 1;
				}
				row.push(field);
				rows.push(row);
				row = [];
				field = "";
			} else {
				field += char;
			}
		}

		if (field !== "" || row.length > 0) {
			row.push(field);
			rows.push(row);
		}

		return rows.filter((cells) => cells.some((cell) => cleanCell(cell)));
	}

	// HIS exports in Taiwan are often Big5; fall back to it when UTF-8 decoding
	// produces replacement characters.
	function decodeText(buffer) {
		const bytes = new Uint8Array(buffer);
		const utf8 = new TextDecoder("utf-8").decode(bytes);
		if (!utf8.includes("�")) {
			return utf8;
		}
		try {
			return new TextDecoder("big5").decode(bytes);
		} catch (_error) {
			return utf8;
		}
	}

	function unescapeXml(value) {
		return value.replace(
			/&(?:#x([0-9a-f]+)|#(\d+)|(amp|lt|gt|quot|apos));/gi,
			(_match, hex, dec, named) => {
				if (hex) {
					return String.fromCodePoint(Number.parseInt(hex, 16));
				}
				if (dec) {
					return String.fromCodePoint(Number.parseInt(dec, 10));
				}
				return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[
					named.toLowerCase()
				];
			},
		);
	}

	// Concatenates every <t> run, skipping phonetic (<rPh>) annotations.
	function textOfRuns(xml) {
		const withoutPhonetic = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "");
		let text = "";
		for (const match of withoutPhonetic.matchAll(
			/<t\b[^>]*>([\s\S]*?)<\/t>/g,
		)) {
			text += unescapeXml(match[1]);
		}
		return text;
	}

	function columnIndex(ref) {
		const letters = (ref.match(/^[A-Z]+/i) || [""])[0].toUpperCase();
		let index = 0;
		for (const letter of letters) {
			index = index * 26 + (letter.charCodeAt(0) - 64);
		}
		return index - 1;
	}

	async function inflateRaw(bytes) {
		const stream = new Blob([bytes])
			.stream()
			.pipeThrough(new DecompressionStream("deflate-raw"));
		return new Uint8Array(await new Response(stream).arrayBuffer());
	}

	// Minimal ZIP reader (stored + deflate entries, no ZIP64) — enough for the
	// XLSX files Excel and Google Sheets write.
	async function readZipEntries(buffer) {
		const bytes = new Uint8Array(buffer);
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		let eocd = -1;
		for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i -= 1) {
			if (view.getUint32(i, true) === 0x06054b50) {
				eocd = i;
				break;
			}
		}
		if (eocd === -1) {
			throw new Error("不是有效的 XLSX 檔（找不到 ZIP 目錄）");
		}

		const entryCount = view.getUint16(eocd + 10, true);
		let offset = view.getUint32(eocd + 16, true);
		const decoder = new TextDecoder("utf-8");
		const entries = new Map();

		for (let n = 0; n < entryCount; n += 1) {
			if (view.getUint32(offset, true) !== 0x02014b50) {
				throw new Error("XLSX 檔案目錄損毀");
			}
			const method = view.getUint16(offset + 10, true);
			const compressedSize = view.getUint32(offset + 20, true);
			const nameLength = view.getUint16(offset + 28, true);
			const extraLength = view.getUint16(offset + 30, true);
			const commentLength = view.getUint16(offset + 32, true);
			const localOffset = view.getUint32(offset + 42, true);
			const name = decoder.decode(
				bytes.subarray(offset + 46, offset + 46 + nameLength),
			);
			entries.set(name, { method, compressedSize, localOffset });
			offset += 46 + nameLength + extraLength + commentLength;
		}

		return {
			names: [...entries.keys()],
			async read(name) {
				const entry = entries.get(name);
				if (!entry) {
					return null;
				}
				const local = entry.localOffset;
				const dataStart =
					local +
					30 +
					view.getUint16(local + 26, true) +
					view.getUint16(local + 28, true);
				const data = bytes.subarray(dataStart, dataStart + entry.compressedSize);
				const raw =
					entry.method === 0
						? data
						: entry.method === 8
							? await inflateRaw(data)
							: null;
				if (!raw) {
					throw new Error(`不支援的壓縮方式 (${entry.method})`);
				}
				return decoder.decode(raw);
			},
		};
	}

	function resolveZipPath(target) {
		const cleaned = target.replace(/^\/+/, "");
		return cleaned.startsWith("xl/") ? cleaned : `xl/${cleaned}`;
	}

	// Returns the first worksheet (in workbook order) as an array of row arrays.
	async function readXlsxRows(buffer) {
		const zip = await readZipEntries(buffer);
		let sheetPath = "";

		const workbook = await zip.read("xl/workbook.xml");
		const rels = await zip.read("xl/_rels/workbook.xml.rels");
		if (workbook && rels) {
			const firstSheet = workbook.match(/<sheet\b[^>]*\br:id="([^"]+)"/);
			if (firstSheet) {
				const relMatch = [
					...rels.matchAll(/<Relationship\b([^>]*)\/?>/g),
				].find((match) => match[1].includes(`Id="${firstSheet[1]}"`));
				const target = relMatch?.[1].match(/Target="([^"]+)"/)?.[1];
				if (target) {
					sheetPath = resolveZipPath(target);
				}
			}
		}
		if (!sheetPath) {
			sheetPath =
				zip.names
					.filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
					.sort()[0] || "";
		}

		const sheet = sheetPath ? await zip.read(sheetPath) : null;
		if (!sheet) {
			throw new Error("XLSX 檔裡找不到工作表");
		}

		const sharedXml = (await zip.read("xl/sharedStrings.xml")) || "";
		const shared = [...sharedXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map(
			(match) => textOfRuns(match[1]),
		);

		const rows = [];
		for (const rowMatch of sheet.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
			const cells = [];
			for (const cellMatch of rowMatch[1].matchAll(
				/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g,
			)) {
				const attrs = cellMatch[1];
				const body = cellMatch[2] || "";
				const ref = attrs.match(/\br="([A-Z]+)\d+"/i)?.[1];
				const type = attrs.match(/\bt="([^"]+)"/)?.[1] || "";
				const index = ref ? columnIndex(ref) : cells.length;
				let value = "";

				if (type === "inlineStr") {
					value = textOfRuns(body);
				} else {
					const raw = body.match(/<v>([\s\S]*?)<\/v>/)?.[1];
					if (raw !== undefined) {
						value =
							type === "s"
								? shared[Number.parseInt(raw, 10)] || ""
								: unescapeXml(raw);
					}
				}
				cells[index] = value;
			}
			rows.push(Array.from(cells, (cell) => (cell === undefined ? "" : cell)));
		}

		return rows.filter((cells) => cells.some((cell) => cleanCell(cell)));
	}

	// Finds the header row (the first row with a drug-name column within the
	// first 20 rows) and maps it to item fields.
	function detectColumns(rows) {
		const limit = Math.min(rows.length, 20);
		for (let rowIndex = 0; rowIndex < limit; rowIndex += 1) {
			const headers = rows[rowIndex].map(normalizeHeader);
			const columns = { locations: [] };

			for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
				const index = headers.findIndex((header) =>
					aliases.includes(header),
				);
				if (index !== -1) {
					columns[field] = index;
				}
			}
			headers.forEach((header, index) => {
				if (header && LOCATION_HEADER_PATTERN.test(header)) {
					columns.locations.push({
						index,
						label: cleanCell(rows[rowIndex][index]),
					});
				}
			});

			if (columns.name !== undefined) {
				return { headerRow: rowIndex, columns };
			}
		}
		return null;
	}

	function rowsToFormulary(rows) {
		const detected = detectColumns(rows || []);
		if (!detected) {
			throw new Error("找不到「藥名」欄位，請確認第一列是欄位名稱");
		}

		const { headerRow, columns } = detected;
		const cell = (row, field) =>
			columns[field] === undefined ? "" : cleanCell(row[columns[field]]);
		const items = [];

		for (const row of rows.slice(headerRow + 1)) {
			const name = cell(row, "name");
			if (!name) {
				continue;
			}
			const item = { code: cell(row, "code"), name };
			const atc = normalizeAtc(cell(row, "atc"));
			if (atc) {
				item.atc = atc;
			}
			for (const field of ["pharm", "form", "nhiPrice", "selfPrice"]) {
				const value = cell(row, field);
				if (value) {
					item[field] = value;
				}
			}
			const locations = columns.locations
				.map(({ index, label }) => [label, cleanCell(row[index])])
				.filter(([, value]) => value);
			if (locations.length > 0) {
				item.locations = locations;
			}
			items.push(item);
		}

		const missing = Object.keys(COLUMN_ALIASES).filter(
			(field) => columns[field] === undefined,
		);
		return {
			items,
			missingColumns: missing,
			withAtc: items.filter((item) => item.atc).length,
		};
	}

	async function parseFormularyFile(fileName, buffer) {
		const isXlsx =
			/\.xlsx$/i.test(fileName || "") ||
			new Uint8Array(buffer.slice(0, 2)).join(",") === "80,75"; // "PK"
		const rows = isXlsx
			? await readXlsxRows(buffer)
			: parseCsv(decodeText(buffer));
		return rowsToFormulary(rows);
	}

	function parseFormularyText(text) {
		return rowsToFormulary(parseCsv(text));
	}

	// Turns whatever Google Sheets link the user pastes into one that returns
	// CSV. Returns "" for anything that isn't an https URL.
	//   .../spreadsheets/d/e/<pubId>/pubhtml?gid=..  -> .../pub?gid=..&output=csv
	//   .../spreadsheets/d/<id>/edit#gid=123         -> .../gviz/tq?tqx=out:csv&gid=123
	// Other https URLs (a CSV hosted elsewhere) are used as they are.
	function sheetCsvUrl(input) {
		let url;
		try {
			url = new URL(String(input || "").trim());
		} catch (_error) {
			return "";
		}
		if (url.protocol !== "https:") {
			return "";
		}
		if (url.hostname !== "docs.google.com") {
			return url.href;
		}

		const gid =
			url.searchParams.get("gid") ||
			(url.hash.match(/gid=(\d+)/) || [])[1] ||
			"";

		const published = url.pathname.match(
			/^\/spreadsheets\/d\/e\/([\w-]+)\/pub(?:html)?/,
		);
		if (published) {
			const next = new URL(
				`https://docs.google.com/spreadsheets/d/e/${published[1]}/pub`,
			);
			if (gid) {
				next.searchParams.set("gid", gid);
				next.searchParams.set("single", "true");
			}
			next.searchParams.set("output", "csv");
			return next.href;
		}

		const shared = url.pathname.match(/^\/spreadsheets\/d\/([\w-]+)/);
		if (shared) {
			const next = new URL(
				`https://docs.google.com/spreadsheets/d/${shared[1]}/gviz/tq`,
			);
			next.searchParams.set("tqx", "out:csv");
			if (gid) {
				next.searchParams.set("gid", gid);
			}
			return next.href;
		}

		return url.href;
	}

	// A short fingerprint of the list so devices can tell whether it changed.
	function formularyFingerprint(items) {
		let hash = 0x811c9dc5;
		const text = JSON.stringify(items || []);
		for (let i = 0; i < text.length; i += 1) {
			hash ^= text.charCodeAt(i);
			hash = Math.imul(hash, 0x01000193);
		}
		return `${(items || []).length}-${(hash >>> 0).toString(16)}`;
	}

	// --------------------------------------------------------------- matching

	function latinTokens(text) {
		return String(text || "")
			.normalize("NFKC")
			.toLowerCase()
			.split(/[^a-z]+/)
			.filter(Boolean);
	}

	function cjkRuns(text) {
		return String(text || "").match(/[㐀-鿿豈-﫿]+/g) || [];
	}

	function keywordsOf(name) {
		const keywords = new Set();
		for (const token of latinTokens(name)) {
			if (token.length >= MIN_LATIN_KEYWORD && !STOP_WORDS.has(token)) {
				keywords.add(token);
			}
		}
		for (const run of cjkRuns(name)) {
			if (run.length >= MIN_CJK_KEYWORD && !CJK_STOP_WORDS.has(run)) {
				keywords.add(run);
			}
		}
		return keywords;
	}

	function createIndex(items) {
		const list = Array.isArray(items) ? items : [];
		const keywords = list.map((item) => keywordsOf(item.name));
		const documentFrequency = new Map();
		for (const set of keywords) {
			for (const keyword of set) {
				documentFrequency.set(
					keyword,
					(documentFrequency.get(keyword) || 0) + 1,
				);
			}
		}
		return {
			items: list,
			keywords,
			lowerNames: list.map((item) => item.name.normalize("NFKC").toLowerCase()),
			documentFrequency,
		};
	}

	function byAtcThenName(a, b) {
		return (
			(a.atc || "").localeCompare(b.atc || "") || a.name.localeCompare(b.name)
		);
	}

	// Same-ingredient and same-class neighbours for a set of ATC codes, leaving
	// out the items already listed as direct matches.
	function relatedByAtc(index, atcCodes, excluded, limits = DEFAULT_LIMITS) {
		const codes = [...new Set(atcCodes.map(normalizeAtc).filter(Boolean))];
		const fullCodes = new Set(codes.filter((code) => code.length === 7));
		const classCodes = [...new Set(codes.map(atcClassOf).filter(Boolean))];
		const skip = new Set(excluded);

		const sameIngredient = index.items
			.filter((item) => !skip.has(item) && fullCodes.has(item.atc))
			.sort(byAtcThenName);
		for (const item of sameIngredient) {
			skip.add(item);
		}

		const classes = classCodes
			.map((atcClass) => ({
				atcClass,
				items: index.items
					.filter(
						(item) =>
							!skip.has(item) && item.atc && item.atc.startsWith(atcClass),
					)
					.sort(byAtcThenName)
					.slice(0, limits.perClass),
			}))
			.filter((group) => group.items.length > 0);

		return {
			sameIngredient: sameIngredient.slice(0, limits.sameIngredient),
			classes,
		};
	}

	function lookup(index, query, limits = DEFAULT_LIMITS) {
		const text = String(query || "").normalize("NFKC").trim();
		const empty = { query: text, direct: [], sameIngredient: [], classes: [] };
		if (!text || !index?.items?.length) {
			return empty;
		}

		const lowerQuery = text.toLowerCase();
		const queryTokens = new Set(latinTokens(text));
		// A short query with no spaces may be a partial name ("crest") or a
		// billing code ("OATOR40") — also try it as a substring.
		const substringQuery =
			lowerQuery.length >= 3 && !/\s/.test(lowerQuery) ? lowerQuery : "";

		const scored = [];
		index.items.forEach((item, i) => {
			let score = 0;
			for (const keyword of index.keywords[i]) {
				const isCjk = /[㐀-鿿豈-﫿]/.test(keyword);
				const hit = isCjk ? text.includes(keyword) : queryTokens.has(keyword);
				if (hit) {
					score += 1 / index.documentFrequency.get(keyword);
				}
			}
			if (substringQuery) {
				if (item.code && item.code.toLowerCase() === substringQuery) {
					score += 2;
				} else if (index.lowerNames[i].includes(substringQuery)) {
					score += 1;
				}
			}
			if (score > 0) {
				scored.push({ item, score, keywordCount: index.keywords[i].size });
			}
		});

		if (scored.length === 0) {
			return empty;
		}

		const best = Math.max(...scored.map((entry) => entry.score));
		const direct = scored
			.filter((entry) => entry.score >= best * RELATIVE_SCORE_THRESHOLD)
			// Ties: single-ingredient products (fewer name keywords) before combos.
			.sort(
				(a, b) =>
					b.score - a.score ||
					a.keywordCount - b.keywordCount ||
					a.item.name.localeCompare(b.item.name),
			)
			.slice(0, limits.direct)
			.map((entry) => entry.item);

		return {
			query: text,
			direct,
			...relatedByAtc(
				index,
				direct.map((item) => item.atc || ""),
				direct,
				limits,
			),
		};
	}

	// For drugs not stocked in-house: neighbours of externally supplied ATC
	// codes (e.g. a Groq guess for the selected drug name).
	function lookupByAtc(index, atcCodes, limits = DEFAULT_LIMITS) {
		return relatedByAtc(index, atcCodes || [], [], limits);
	}

	// ---------------------------------------------------------------- RxClass

	// Drug-name candidates to send to RxClass. A short selection is tried as a
	// whole phrase first ("sodium bicarbonate"); every remaining word that could
	// be a drug name is tried on its own. RxNorm only knows English names, so
	// Chinese text yields nothing.
	function rxclassTerms(text, max = MAX_RXCLASS_TERMS) {
		const words =
			String(text || "")
				.normalize("NFKC")
				.match(/[A-Za-z][A-Za-z-]*[A-Za-z]/g) || [];
		const terms = [];
		const seen = new Set();
		const add = (term) => {
			const key = term.toLowerCase();
			if (!seen.has(key) && terms.length < max) {
				seen.add(key);
				terms.push(term);
			}
		};

		if (words.length >= 2 && words.length <= 4) {
			add(words.join(" "));
		}
		for (const word of words) {
			const lower = word.toLowerCase();
			if (
				lower.length >= MIN_LATIN_KEYWORD &&
				!STOP_WORDS.has(lower) &&
				!RXCLASS_TERM_STOP_WORDS.has(lower)
			) {
				add(word);
			}
		}
		return terms;
	}

	// Parses an RxClass class/byDrugName response (relaSource=ATC) into
	// { ingredient, atcClass, className } entries. RxClass links drugs to ATC
	// level-4 classes (5 characters), which is exactly the "same mechanism"
	// granularity used here.
	function parseRxClassResponse(json) {
		const list = json?.rxclassDrugInfoList?.rxclassDrugInfo;
		if (!Array.isArray(list)) {
			return [];
		}
		const results = [];
		const seen = new Set();
		for (const info of list) {
			const concept = info?.rxclassMinConceptItem;
			const classType = String(concept?.classType || "");
			const atcClass = normalizeAtc(concept?.classId);
			const ingredient = cleanCell(info?.minConcept?.name).toLowerCase();
			if (!/^ATC/i.test(classType) || atcClass.length !== 5 || !ingredient) {
				continue;
			}
			const key = `${ingredient}|${atcClass}`;
			if (seen.has(key)) {
				continue;
			}
			seen.add(key);
			results.push({
				ingredient,
				atcClass,
				className: cleanCell(concept?.className),
			});
		}
		return results;
	}

	// Turns RxClass matches into formulary results: items whose names match the
	// RxNorm ingredient are "same ingredient" (so a US brand like Lipitor still
	// lands on the in-house atorvastatin), and the ATC classes give the
	// same-mechanism groups.
	function lookupByIngredients(index, matches, limits = DEFAULT_LIMITS) {
		const sameIngredient = [];
		const seen = new Set();
		const ingredients = [
			...new Set((matches || []).map((match) => match.ingredient)),
		];
		for (const ingredient of ingredients) {
			for (const item of lookup(index, ingredient, limits).direct) {
				if (!seen.has(item)) {
					seen.add(item);
					sameIngredient.push(item);
				}
			}
		}

		const related = relatedByAtc(
			index,
			[
				...(matches || []).map((match) => match.atcClass),
				...sameIngredient.map((item) => item.atc || ""),
			],
			sameIngredient,
			limits,
		);
		const classNames = {};
		for (const match of matches || []) {
			if (match.className && !classNames[match.atcClass]) {
				classNames[match.atcClass] = match.className;
			}
		}

		return {
			sameIngredient: [...sameIngredient, ...related.sameIngredient].slice(
				0,
				limits.sameIngredient,
			),
			classes: related.classes,
			classNames,
		};
	}

	root.OEFormulary = {
		FORMULARY_ITEMS_STORAGE_KEY,
		FORMULARY_META_STORAGE_KEY,
		parseCsv,
		decodeText,
		readXlsxRows,
		rowsToFormulary,
		parseFormularyFile,
		parseFormularyText,
		sheetCsvUrl,
		formularyFingerprint,
		FORMULARY_URL_STORAGE_KEY,
		normalizeAtc,
		atcClassOf,
		formLabel,
		keywordsOf,
		createIndex,
		lookup,
		lookupByAtc,
		rxclassTerms,
		parseRxClassResponse,
		lookupByIngredients,
	};
})(typeof globalThis !== "undefined" ? globalThis : self);
