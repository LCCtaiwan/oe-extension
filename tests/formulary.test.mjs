import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

// Unlike the other tests, this loads the real src/formulary.js (a classic
// script that only exposes globalThis.OEFormulary) instead of a copy.
const source = readFileSync(
  fileURLToPath(new URL("../src/formulary.js", import.meta.url)),
  "utf8"
);
const context = { TextDecoder, DecompressionStream, Blob, Response };
vm.createContext(context);
vm.runInContext(source, context);
const F = context.OEFormulary;

const plain = (value) => JSON.parse(JSON.stringify(value));
const names = (items) => plain(items.map((item) => item.name));

// --- CSV parsing --------------------------------------------------------

assert.deepEqual(
  plain(F.parseCsv('﻿a,b\r\n"x, y","say ""hi"""\n\n"multi\nline",z')),
  [
    ["a", "b"],
    ["x, y", 'say "hi"'],
    ["multi\nline", "z"],
  ]
);

// Big5 bytes for "藥名" fall back from UTF-8 to Big5.
assert.equal(F.decodeText(new Uint8Array([0xc3, 0xc4, 0xa6, 0x57]).buffer), "藥名");
assert.equal(F.decodeText(new TextEncoder().encode("藥名").buffer), "藥名");

// --- column detection ---------------------------------------------------

const csv = [
  "院內清單 2026/11",
  "批價碼,藥名,P1儲位,P2儲位,藥庫, 健保價 , 自費價 ,ATC碼,藥理代碼,劑型",
  "OROSU,Rosuvastatin (Crestor) 冠脂妥 10mg/tab,T08,  ,E161,10,12,C10AA07,DN203 ,O",
  "OPAXL,Paxlovid(Nirmatrelvir/Ritonavir) 300/100mg,,,,0,0,XCOVID0,KL002,O",
  ",,,,,,,,,",
].join("\n");
const parsedCsv = F.rowsToFormulary(F.parseCsv(csv));
assert.equal(parsedCsv.items.length, 2);
assert.deepEqual(plain(parsedCsv.missingColumns), []);
assert.deepEqual(plain(parsedCsv.items[0]), {
  code: "OROSU",
  name: "Rosuvastatin (Crestor) 冠脂妥 10mg/tab",
  atc: "C10AA07",
  pharm: "DN203",
  form: "O",
  nhiPrice: "10",
  selfPrice: "12",
  locations: [
    ["P1儲位", "T08"],
    ["藥庫", "E161"],
  ],
});
// Pseudo ATC codes are dropped rather than used for grouping.
assert.equal(parsedCsv.items[1].atc, undefined);
assert.equal(parsedCsv.withAtc, 1);

assert.throws(() => F.rowsToFormulary([["foo", "bar"]]), /藥名/);

// --- ATC helpers --------------------------------------------------------

assert.equal(F.normalizeAtc(" c10aa07 "), "C10AA07");
assert.equal(F.normalizeAtc("XCOVID0"), "");
assert.equal(F.atcClassOf("C10AA07"), "C10AA");
assert.equal(F.atcClassOf("G04BC"), "G04BC");
assert.equal(F.atcClassOf("B05"), "");
assert.equal(F.formLabel("O"), "口服");
assert.equal(F.formLabel("H"), "H");

// --- XLSX parsing (synthetic fixture; header on row 2, title row above) --

const xlsx = readFileSync(fileURLToPath(new URL("./fixtures/formulary-sample.xlsx", import.meta.url)));
const parsed = await F.parseFormularyFile(
  "formulary-sample.xlsx",
  xlsx.buffer.slice(xlsx.byteOffset, xlsx.byteOffset + xlsx.byteLength)
);
assert.equal(parsed.items.length, 10);
assert.deepEqual(plain(parsed.missingColumns), []);
assert.equal(parsed.items[0].code, "OROSU");
assert.equal(parsed.items[0].nhiPrice, "10");
assert.deepEqual(plain(parsed.items[0].locations), [
  ["P1儲位", "T01"],
  ["藥庫", "E001"],
]);
// XML entities in shared strings are unescaped.
assert.equal(parsed.items[9].name, "Glycerin & Water <topical> 500gm/bt");
assert.equal(parsed.items[9].atc, undefined);

// --- lookup -------------------------------------------------------------

const index = F.createIndex(parsed.items);

// Generic name: direct hit, plus the other statin as same-mechanism.
let result = F.lookup(index, "rosuvastatin");
assert.deepEqual(names(result.direct), ["Rosuvastatin (Crestor) 冠脂妥 10mg/tab"]);
assert.deepEqual(plain(result.classes.map((group) => group.atcClass)), ["C10AA"]);
assert.deepEqual(names(result.classes[0].items), ["Atorvastatin (Tulip) 妥寧 40 mg/tab"]);

// Brand name in Chinese, billing code, and a partial brand name.
assert.deepEqual(names(F.lookup(index, "冠脂妥").direct), ["Rosuvastatin (Crestor) 冠脂妥 10mg/tab"]);
assert.deepEqual(names(F.lookup(index, "oator40").direct), ["Atorvastatin (Tulip) 妥寧 40 mg/tab"]);
assert.deepEqual(names(F.lookup(index, "crest").direct), ["Rosuvastatin (Crestor) 冠脂妥 10mg/tab"]);

// Single-ingredient product sorts before the combination that contains it.
assert.deepEqual(names(F.lookup(index, "Atorvastatin 40 mg daily").direct), [
  "Atorvastatin (Tulip) 妥寧 40 mg/tab",
  "Atozet (Ezetimibe/Atorvastatin) 優泰脂 10/20 mg/tab",
]);

// Several drugs in one sentence; Tall Man lettering is case-insensitive.
result = F.lookup(index, "Patients on metformin and dapagliflozin had fewer events");
assert.deepEqual(names(result.direct).sort(), [
  "Dapagliflozin (Forxiga) 福適佳 10mg/tab",
  "MetFORMIN (Ankomin) 美克糖 500 mg/tab",
]);

// Calcium gluconate and carbonate share ATC class A12AA.
result = F.lookup(index, "calcium gluconate");
assert.deepEqual(names(result.direct), ["Calcium Gluconate 鈣克康 10ml/amp"]);
assert.deepEqual(names(result.classes[0].items), ["Calcium Carbonate 500mg/tab 碳酸鈣"]);

// Not stocked: nothing direct, nothing related.
result = F.lookup(index, "empagliflozin");
assert.deepEqual(plain(result), { query: "empagliflozin", direct: [], sameIngredient: [], classes: [] });

// ...but an externally supplied ATC (e.g. Groq's guess) finds the SGLT2i class.
const byAtc = F.lookupByAtc(index, ["A10BK03"]);
assert.deepEqual(names(byAtc.sameIngredient), []);
assert.deepEqual(names(byAtc.classes[0].items), ["Dapagliflozin (Forxiga) 福適佳 10mg/tab"]);

// Same ATC (7 chars) is listed as same ingredient, not as same class.
const dupIndex = F.createIndex([
  ...parsed.items,
  { code: "OROSU5", name: "Rosuvas 5mg/tab", atc: "C10AA07" },
]);
result = F.lookup(dupIndex, "rosuvastatin");
assert.deepEqual(names(result.sameIngredient), ["Rosuvas 5mg/tab"]);
assert.deepEqual(names(result.classes[0].items), ["Atorvastatin (Tulip) 妥寧 40 mg/tab"]);

// Empty inputs.
assert.deepEqual(plain(F.lookup(index, "  ").direct), []);
assert.deepEqual(plain(F.lookup(F.createIndex([]), "rosuvastatin").direct), []);

// --- RxClass -----------------------------------------------------------

// Short phrase first, then candidate words; prose words and units dropped.
assert.deepEqual(plain(F.rxclassTerms("sodium bicarbonate")), [
  "sodium bicarbonate",
  "sodium",
  "bicarbonate",
]);
assert.deepEqual(
  plain(F.rxclassTerms("In patients with heart failure, empagliflozin 10 mg daily reduced hospitalization")),
  ["empagliflozin"]
);
assert.deepEqual(plain(F.rxclassTerms("Lipitor")), ["Lipitor"]);
assert.deepEqual(plain(F.rxclassTerms("恩排糖")), []);
assert.equal(F.rxclassTerms("alpha beta gamma delta epsilon zeta theta iota kappa lambda").length, 8);

// Shape of RxNav's class/byDrugName.json?relaSource=ATC response.
const rxclassResponse = {
  rxclassDrugInfoList: {
    rxclassDrugInfo: [
      {
        minConcept: { rxcui: "83367", name: "atorvastatin", tty: "IN" },
        rxclassMinConceptItem: {
          classId: "C10AA",
          className: "HMG CoA reductase inhibitors",
          classType: "ATC1-4",
        },
        rela: "",
        relaSource: "ATC",
      },
      // Duplicate (another product of the same ingredient) is collapsed.
      {
        minConcept: { rxcui: "617312", name: "Atorvastatin", tty: "IN" },
        rxclassMinConceptItem: { classId: "C10AA", className: "HMG CoA reductase inhibitors", classType: "ATC1-4" },
        relaSource: "ATC",
      },
      // Combination class from a multi-ingredient product.
      {
        minConcept: { rxcui: "83367", name: "atorvastatin", tty: "IN" },
        rxclassMinConceptItem: { classId: "C10BA", className: "Combinations of various lipid modifying agents", classType: "ATC1-4" },
        relaSource: "ATC",
      },
      // Non-ATC and malformed entries are ignored.
      {
        minConcept: { rxcui: "83367", name: "atorvastatin", tty: "IN" },
        rxclassMinConceptItem: { classId: "N0000175589", className: "HMG-CoA Reductase Inhibitor", classType: "EPC" },
        relaSource: "DAILYMED",
      },
      { minConcept: {}, rxclassMinConceptItem: { classId: "C10", classType: "ATC1-4" } },
    ],
  },
};
const rxMatches = plain(F.parseRxClassResponse(rxclassResponse));
assert.deepEqual(rxMatches, [
  { ingredient: "atorvastatin", atcClass: "C10AA", className: "HMG CoA reductase inhibitors" },
  { ingredient: "atorvastatin", atcClass: "C10BA", className: "Combinations of various lipid modifying agents" },
]);
assert.deepEqual(plain(F.parseRxClassResponse({})), []);
assert.deepEqual(plain(F.parseRxClassResponse(null)), []);

// A US brand (Lipitor) isn't in the list by name; RxClass gives the
// ingredient, which lands on the in-house atorvastatin products as same
// ingredient, and the statin class for same mechanism.
assert.deepEqual(names(F.lookup(index, "Lipitor").direct), []);
const viaRx = F.lookupByIngredients(index, rxMatches);
assert.deepEqual(names(viaRx.sameIngredient), [
  "Atorvastatin (Tulip) 妥寧 40 mg/tab",
  "Atozet (Ezetimibe/Atorvastatin) 優泰脂 10/20 mg/tab",
]);
assert.deepEqual(plain(viaRx.classes.map((group) => group.atcClass)), ["C10AA"]);
assert.deepEqual(names(viaRx.classes[0].items), ["Rosuvastatin (Crestor) 冠脂妥 10mg/tab"]);
assert.equal(viaRx.classNames.C10AA, "HMG CoA reductase inhibitors");

// Not stocked (empagliflozin): class only.
const viaRxEmpa = F.lookupByIngredients(index, [
  { ingredient: "empagliflozin", atcClass: "A10BK", className: "SGLT2 inhibitors" },
]);
assert.deepEqual(names(viaRxEmpa.sameIngredient), []);
assert.deepEqual(names(viaRxEmpa.classes[0].items), ["Dapagliflozin (Forxiga) 福適佳 10mg/tab"]);
