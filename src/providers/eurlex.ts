/**
 * EUR-Lex Provider — syncs EU regulations via the EU Cellar SPARQL endpoint.
 * Uses Formex XML (fmx4) for structured parsing of articles and recitals.
 * No WAF issues — Cellar is a machine-readable API.
 */
import { XMLParser } from "fast-xml-parser";
import type { LawSyncProvider, LawConfig, SyncResult, SupplementConfig, SupplementResult, TocNode, Provision, SupplementItem } from "../types.js";
import { log } from "../log.js";
import { Buffer } from "node:buffer";

const SPARQL_URL = "https://publications.europa.eu/webapi/rdf/sparql";

/** Language code mapping: ISO 639-1 → EU authority code */
const LANG_MAP: Record<string, string> = {
  bg: "BUL", cs: "CES", da: "DAN", de: "DEU", el: "ELL", en: "ENG", es: "SPA",
  et: "EST", fi: "FIN", fr: "FRA", ga: "GLE", hr: "HRV", hu: "HUN", it: "ITA",
  lt: "LIT", lv: "LAV", mt: "MLT", nl: "NLD", pl: "POL", pt: "POR", ro: "RON",
  sk: "SLK", sl: "SLV", sv: "SWE",
};

/** Find the Cellar Formex manifestation URL for a CELEX number + language. Two-step: CELEX → work URI → manifestation. */
async function findFormexUrl(celex: string, lang: string): Promise<string | null> {
  const euLang = LANG_MAP[lang] ?? lang.toUpperCase();

  // Step 1: CELEX → work URI (use FILTER for reliable string matching)
  const workQuery = `PREFIX cdm: <http://publications.europa.eu/ontology/cdm#>
SELECT ?w WHERE { ?w cdm:resource_legal_id_celex ?celex . FILTER(str(?celex) = '${celex}') } LIMIT 1`;
  const workRes = await sparql(workQuery);
  const workUri = workRes[0]?.w;
  if (!workUri) { log.error("No work found for CELEX %s", celex); return null; }

  // Step 2: work URI → expression → Formex manifestation (.02 suffix = fmx4)
  const mfQuery = `PREFIX cdm: <http://publications.europa.eu/ontology/cdm#>
SELECT ?m WHERE {
  ?e cdm:expression_belongs_to_work <${workUri}> .
  ?e cdm:expression_uses_language <http://publications.europa.eu/resource/authority/language/${euLang}> .
  ?m cdm:manifestation_manifests_expression ?e .
  FILTER(STRENDS(str(?m), '.02'))
} LIMIT 1`;
  const mfRes = await sparql(mfQuery);
  return mfRes[0]?.m ?? null;
}

/** Execute a SPARQL query and return bindings as simple key-value objects. */
async function sparql(query: string): Promise<Record<string, string>[]> {
  const url = `${SPARQL_URL}?query=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { "Accept": "application/sparql-results+json", "User-Agent": "openlex-lawsync/1.0" } });
  if (!res.ok) { log.error("SPARQL failed: %d", res.status); return []; }
  const data = await res.json() as { results: { bindings: Record<string, { value: string }>[] } };
  return data.results.bindings.map((b) => Object.fromEntries(Object.entries(b).map(([k, v]) => [k, v.value])));
}

import { unzipXml, unzipAllXml } from "../zip.js";

/** Fetch the Formex XML document. Handles both direct XML (DOC_2) and ZIP archives (DOC_1). */
async function fetchFormex(manifestationUrl: string): Promise<string> {
  // Try DOC_2 first (single XML file, like DSGVO)
  for (const doc of ["/DOC_2", "/DOC_1"]) {
    const url = `${manifestationUrl}${doc}`;
    log.info("  Fetching Formex from Cellar: %s", url);

    // Try as direct XML
    const xmlRes = await fetch(url, { headers: { "Accept": "application/xml;type=fmx4" } });
    if (xmlRes.ok) return xmlRes.text();

    // Try as ZIP (AI Act and other large regulations)
    if (xmlRes.status === 406) {
      const zipRes = await fetch(url, { headers: { "Accept": "application/zip" } });
      if (!zipRes.ok) continue;
      const buf = Buffer.from(await zipRes.arrayBuffer());
      return unzipXml(new Uint8Array(buf), (_name, data) => {
        // Formex: the regulation body is always an <ACT> document
        const head = new TextDecoder().decode(data.slice(0, 500));
        return /<ACT[\s>]/.test(head);
      });
    }
  }
  throw new Error(`Cellar fetch failed for ${manifestationUrl}`);
}

/** Fetch the raw ZIP buffer from a manifestation URL (for multi-file extraction). Returns null if not a ZIP. */
async function fetchFormexZip(manifestationUrl: string): Promise<Uint8Array | null> {
  for (const doc of ["/DOC_2", "/DOC_1"]) {
    const url = `${manifestationUrl}${doc}`;
    const xmlRes = await fetch(url, { headers: { "Accept": "application/xml;type=fmx4" } });
    if (xmlRes.ok) return null; // direct XML, no ZIP
    if (xmlRes.status === 406) {
      const zipRes = await fetch(url, { headers: { "Accept": "application/zip" } });
      if (zipRes.ok) return new Uint8Array(await zipRes.arrayBuffer());
    }
  }
  return null;
}

/** Extract text content from a Formex XML element, converting to Markdown. */
function fmxToMarkdown(xml: string): string {
  return xml
    .replace(/<P>/gi, "").replace(/<\/P>/gi, "\n\n")
    .replace(/<ALINEA>/gi, "").replace(/<\/ALINEA>/gi, "\n\n")
    .replace(/<NP>/gi, "").replace(/<\/NP>/gi, "\n")
    .replace(/<NO\.P>([^<]+)<\/NO\.P>/gi, "$1 ")
    .replace(/<NO\.PARAG>([^<]+)<\/NO\.PARAG>/gi, "$1 ")
    .replace(/<TXT>([^<]*)<\/TXT>/gi, "$1")
    .replace(/<HT TYPE="ITALIC">([^<]*)<\/HT>/gi, "*$1*")
    .replace(/<HT TYPE="BOLD">([^<]*)<\/HT>/gi, "**$1**")
    .replace(/<HT TYPE="UC">([^<]*)<\/HT>/gi, "$1")
    .replace(/<HT TYPE="EXPANDED">([^<]*)<\/HT>/gi, "$1")
    .replace(/<LIST[^>]*>/gi, "\n").replace(/<\/LIST>/gi, "\n")
    .replace(/<ITEM>/gi, "").replace(/<\/ITEM>/gi, "")
    .replace(/<NOTE[^>]*>[\s\S]*?<\/NOTE>/gi, "")
    .replace(/<DATE[^>]*>([^<]*)<\/DATE>/gi, "$1")
    .replace(/<REF[^>]*>([^<]*)<\/REF[^>]*>/gi, "$1")
    .replace(/<QUOT\.[^>]*\/>/gi, "\"")
    .replace(/<FT[^>]*>([^<]*)<\/FT>/gi, "$1")
    .replace(/<\?PAGE[^?]*\?>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

/** Parse a Formex DIVISION into a TocNode with children (articles + nested divisions). */
function parseDivision(div: Record<string, unknown>, provisions: Provision[]): TocNode {
  const label = textOf((div.TITLE as Record<string, unknown>)?.TI ?? "");
  const title = textOf((div.TITLE as Record<string, unknown>)?.STI ?? "");
  const children: TocNode[] = [];

  // Nested divisions (sections within chapters)
  for (const sub of asArray<Record<string, unknown>>(div.DIVISION as Record<string, unknown>[] | Record<string, unknown> | undefined)) {
    children.push(parseDivision(sub, provisions));
  }

  // Articles directly in this division
  for (const art of asArray<Record<string, unknown>>(div.ARTICLE as Record<string, unknown>[] | Record<string, unknown> | undefined)) {
    const id = art["@_IDENTIFIER"] as string | undefined;
    if (!id) continue;
    const nr = id.replace(/^0+/, "");
    const prov = provisions.find((p) => p.nr === nr);
    if (prov) children.push({ nr: prov.nr, title: prov.title });
  }

  return { label, title, children };
}

const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", trimValues: true });

/** Extract plain text from a Formex node that may contain nested HT (highlight) elements. */
function textOf(node: unknown): string {
  if (!node) return "";
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  const obj = node as Record<string, unknown>;
  if (obj["#text"] != null) return String(obj["#text"]);
  if (obj.HT) return textOf(obj.HT);
  if (obj.P) return textOf(obj.P);
  return "";
}

/** Ensure a value is an array. */
function asArray<T>(v: T | T[] | undefined): T[] {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

/** Parse a Formex ARTICLE element into a Provision. */
function parseArticle(article: Record<string, unknown>): Provision | null {
  const id = article["@_IDENTIFIER"] as string | undefined;
  if (!id) return null;
  const nr = id.replace(/^0+/, "");
  const title = textOf((article as Record<string, unknown>)["STI.ART"] ?? "");
  // Re-serialize article body to string for fmxToMarkdown (which handles inline formatting)
  const bodyXml = articleBodyToXml(article);
  const text = fmxToMarkdown(bodyXml);
  if (!text) return null;
  return { nr, title, text };
}

/** Re-serialize article content (PARAGs) back to XML string for fmxToMarkdown. */
function articleBodyToXml(article: Record<string, unknown>): string {
  // fmxToMarkdown expects raw XML — we need the original XML substring
  // Since fast-xml-parser doesn't preserve raw XML, we extract from the original string
  // This is handled by passing the raw XML to fetchLaw and using regex for article body extraction
  // For now, return empty — we'll use a hybrid approach
  return "";
}

export const eurlexProvider: LawSyncProvider = {
  id: "eurlex",
  supportedLanguages: Object.keys(LANG_MAP),

  async fetchLaw(config: LawConfig, lang?: string): Promise<SyncResult> {
    if (!config.celex) throw new Error(`Missing celex for ${config.slug}`);
    const targetLang = lang ?? config.lang;
    const url = await findFormexUrl(config.celex, targetLang);
    if (!url) throw new Error(`No Formex manifestation found for ${config.celex} in ${targetLang}`);
    const rawXml = await fetchFormex(url);

    // Use XML parser for structure (DIVISION hierarchy)
    const doc = xmlParser.parse(rawXml);
    const enactingTerms = doc.ACT?.["ENACTING.TERMS"];

    // Use regex for article body extraction (fmxToMarkdown needs raw XML)
    const provisions: Provision[] = [];
    const articleRe = /<ARTICLE IDENTIFIER="(\d+\w*)">([\s\S]*?)<\/ARTICLE>/gi;
    let m: RegExpExecArray | null;
    while ((m = articleRe.exec(rawXml))) {
      const nr = m[1]!.replace(/^0+/, "");
      const body = m[2]!;
      const tiMatch = body.match(/<STI\.ART>([^<]*)<\/STI\.ART>/);
      const title = tiMatch ? tiMatch[1]!.trim() : "";
      const text = fmxToMarkdown(body);
      if (!text) continue;
      provisions.push({ nr, title, text });
    }

    // Build TOC from parsed DIVISION structure
    const toc: TocNode[] = [];
    if (enactingTerms?.DIVISION) {
      for (const div of asArray<Record<string, unknown>>(enactingTerms.DIVISION)) {
        toc.push(parseDivision(div, provisions));
      }
    } else {
      // No divisions — flat article list
      for (const p of provisions) {
        toc.push({ nr: p.nr, title: p.title });
      }
    }

    return { provisions, toc };
  },

  async fetchSupplement(config: LawConfig, type: string, _supplementCfg: SupplementConfig, lang?: string): Promise<SupplementResult> {
    if (!config.celex) throw new Error(`Missing celex for ${config.slug}`);
    const targetLang = lang ?? config.lang;
    const url = await findFormexUrl(config.celex, targetLang);
    if (!url) throw new Error(`No Formex manifestation found for ${config.celex} in ${targetLang}`);

    if (type === "annexes") return fetchAnnexes(url);

    // Default: recitals from ACT XML
    const xml = await fetchFormex(url);
    const items: SupplementItem[] = [];
    const considRe = /<CONSID>([\s\S]*?)<\/CONSID>/gi;
    let m: RegExpExecArray | null;
    while ((m = considRe.exec(xml))) {
      const body = m[1]!;
      const noMatch = body.match(/<NO\.P>\((\d+)\)<\/NO\.P>/);
      if (!noMatch) continue;
      const nr = noMatch[1]!;
      const text = fmxToMarkdown(body);
      if (text) items.push({ nr, text });
    }
    return { items };
  },
};

/** Roman numeral → Arabic number */
const ROMAN: Record<string, number> = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, X: 10, XI: 11, XII: 12, XIII: 13, XIV: 14, XV: 15 };

/** Fetch annexes from a Formex ZIP (separate ANNEX XML files). */
async function fetchAnnexes(manifestationUrl: string): Promise<SupplementResult> {
  const zip = await fetchFormexZip(manifestationUrl);
  if (!zip) return { items: [] }; // no ZIP = no separate annexes
  const annexXmls = unzipAllXml(zip, (_name, data) => {
    const head = new TextDecoder().decode(data.slice(0, 200));
    return /<ANNEX[\s>]/.test(head);
  });
  const items: SupplementItem[] = [];
  for (const xml of annexXmls) {
    const tiMatch = xml.match(/<TITLE>[\s\S]*?<TI>[\s\S]*?<P>\s*(?:ANHANG|ANNEX|ANNEXE)\s+([IVXLC]+)\s*<\/P>/i);
    if (!tiMatch) continue;
    const nr = String(ROMAN[tiMatch[1]!] ?? tiMatch[1]!);
    const stiMatch = xml.match(/<STI>[\s\S]*?<P>([\s\S]*?)<\/P>/);
    const title = stiMatch ? fmxToMarkdown(stiMatch[1]!).trim() : "";
    const contentsMatch = xml.match(/<CONTENTS>([\s\S]*)<\/CONTENTS>/);
    const text = contentsMatch ? fmxToMarkdown(contentsMatch[1]!) : "";
    if (text) items.push({ nr, title, text });
  }
  items.sort((a, b) => Number(a.nr) - Number(b.nr));
  log.info("  %d annexes extracted", items.length);
  return { items };
}
