import { pathToFileURL } from "node:url";

export const MAX_WORDS = 400;
const MAX_TEXT_HITS = 10;
const FIELDS = ["Dependencies", "Description", "Precondition", "Actors", "Trigger", "Ordinary Sequence", "Postcondition", "Exceptions", "Alternate Flows", "Business Rules", "UI Components & Rules", "Error States"];
export const UC_ID = /UC_[A-Z]{2}_[A-Z0-9]+/;
const HEADING = /^(UC_[A-Z]{2}_[A-Z0-9]+): (\S.*)$/;

function cleanLines(text) {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const footer = lines.findLastIndex((line) => /^\[a\]\S/.test(line));
  return (footer === -1 ? lines : lines.slice(0, footer)).map((line) => line.replace(/\[[a-z]{1,3}\]/g, "").replace(/^\t/, ""));
}

export function parseTab(text) {
  const useCases = [];
  let current = null;
  let field = null;
  for (const line of cleanLines(text)) {
    const heading = line.match(HEADING);
    if (heading) {
      current = { id: heading[1], title: heading[2].trim(), fields: [], lines: [] };
      field = null;
      useCases.push(current);
      continue;
    }
    if (!current) continue;
    current.lines.push(line);
    if (FIELDS.includes(line.trim())) {
      field = { name: line.trim(), lines: [] };
      current.fields.push(field);
      continue;
    }
    if (field && line.trim()) field.lines.push(line);
  }
  return useCases;
}

function countWords(text) {
  return text.split(/\s+/).filter(Boolean).length;
}

function capWords(text) {
  const words = [...text.matchAll(/\S+/g)];
  if (words.length <= MAX_WORDS) return text;
  const last = words[MAX_WORDS - 1];
  return `${text.slice(0, last.index + last[0].length)} … [cut at ${MAX_WORDS} words; narrow with a locator such as BR3, step 2, AF1]`;
}

export function indexTab(text) {
  return parseTab(text).map((useCase) => ({ id: useCase.id, title: useCase.title, words: countWords(useCase.lines.join(" ")) }));
}

function section(useCase, field, text, locator) {
  const label = [useCase.id, field?.name, locator].filter(Boolean).join(" · ");
  return { label, text: capWords(text) };
}

function locatorPattern(locator) {
  const step = locator.match(/^step (\d+)$/i);
  if (step) return { define: new RegExp(`^${step[1]}\\. `), mention: null };
  if (/^(BR|AF|EF)\d+[A-Z]?$/.test(locator)) return { define: new RegExp(`^•\\s*${locator} \\(|\\(${locator}\\b`), mention: new RegExp(`\\b${locator}\\b`) };
  if (/^#\d+$/.test(locator)) return { define: new RegExp(`(^|\\s)${locator}(\\D|$)`), mention: null };
  return null;
}

function tableRow(useCase, locator) {
  const cells = useCase.lines.map((line) => line.trim()).filter(Boolean);
  const header = cells.indexOf("#");
  if (header === -1) return null;
  const width = cells.slice(header + 1).findIndex((cell) => /^\d+$/.test(cell)) + 1;
  const start = cells.indexOf(locator.slice(1), header + width);
  if (width < 2 || start === -1) return null;
  return section(useCase, null, cells.slice(start, start + width).join(" | "), locator);
}

function searchLines(useCase, fields, matcher, locator) {
  const hits = [];
  for (const field of fields) {
    for (const line of field.lines) if (matcher.test(line)) hits.push(section(useCase, field, line, locator));
  }
  return hits;
}

export function findSections(text, query) {
  const useCases = parseTab(text);
  const id = query.match(UC_ID)?.[0];
  const rest = query.replace(UC_ID, "").trim();
  if (!id) {
    const needle = rest.toLowerCase();
    const hits = useCases.flatMap((useCase) => searchLines(useCase, useCase.fields, { test: (line) => line.toLowerCase().includes(needle) })).slice(0, MAX_TEXT_HITS);
    return { hits, tried: `text "${rest}" in ${useCases.length} use cases (no line)` };
  }
  const useCase = useCases.find((candidate) => candidate.id === id);
  if (!useCase) return { hits: [], tried: `${id} not in tab (headings: ${useCases.map((candidate) => candidate.id).join(", ") || "none"})` };
  if (!rest) return { hits: useCase.fields.map((field) => section(useCase, field, field.lines.join("\n"))), tried: `${id} found` };
  const field = useCase.fields.find((candidate) => rest.toLowerCase().startsWith(candidate.name.toLowerCase()));
  const locator = field ? rest.slice(field.name.length).trim() : rest;
  const scope = field ? [field] : useCase.fields;
  if (field && !locator) return { hits: [section(useCase, field, field.lines.join("\n"))], tried: `${id} found` };
  const row = /^#\d+$/.test(locator) ? tableRow(useCase, locator) : null;
  if (row) return { hits: [row], tried: `${id} found` };
  const pattern = locatorPattern(locator);
  if (pattern) {
    const defining = searchLines(useCase, scope, pattern.define, locator);
    const hits = defining.length || !pattern.mention ? defining : searchLines(useCase, scope, pattern.mention, locator);
    return { hits, tried: `${id} found; locator "${locator}" (no defining or mentioning line${field ? ` in ${field.name}` : ""})` };
  }
  const needle = locator.toLowerCase();
  return { hits: searchLines(useCase, scope, { test: (line) => line.toLowerCase().includes(needle) }), tried: `${id} found; text "${locator}" (no line)` };
}

function normalise(text) {
  return text.replace(/\s+/g, " ").trim();
}

export function quoteInText(quote, text) {
  const needle = normalise(quote);
  return needle.length > 0 && normalise(cleanLines(text).join("\n")).includes(needle);
}

export function quoteCount(quote, text) {
  const needle = normalise(quote).toLowerCase();
  if (!needle) return 0;
  return cleanLines(text).reduce((count, line) => count + normalise(line).toLowerCase().split(needle).length - 1, 0);
}

export async function fetchTab(doc, tab) {
  const url = `https://docs.google.com/document/d/${encodeURIComponent(doc)}/export?format=txt&tab=${encodeURIComponent(tab)}`;
  const response = await fetch(url, { redirect: "follow" });
  const body = await response.text();
  if (!response.ok || /^\s*<(!doctype|html)/i.test(body)) {
    throw new Error(`PRD ${doc} tab ${tab} is not readable without login (HTTP ${response.status}); ask the user to share the doc by link or export the tab`);
  }
  return body;
}

async function main([command, doc, tab, ...queryWords]) {
  if (!["index", "find"].includes(command) || !doc || !tab || (command === "find" && !queryWords.length)) {
    console.error("usage: prd-section.mjs index <doc-id> <tab-id> | find <doc-id> <tab-id> <UC_XX_nn [BRn|AFn|step n|#n|field]|text>");
    process.exit(2);
  }
  const text = await fetchTab(doc, tab);
  if (command === "index") {
    for (const entry of indexTab(text)) console.log(`${entry.id}: ${entry.title} · ${entry.words} words`);
    return;
  }
  const query = queryWords.join(" ");
  const { hits, tried } = findSections(text, query);
  if (!hits.length) {
    console.log(`0 hits for "${query}" in ${doc} ${tab}. tried: ${tried}`);
    process.exit(1);
  }
  for (const hit of hits) console.log(`## ${hit.label}\n${hit.text}\n`);
}

export function run() {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`prd-section: ${error.message}`);
    process.exit(1);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run();
