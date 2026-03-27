/**
 * EUR-Lex Provider — syncs EU regulations via the EU Cellar SPARQL endpoint.
 * Uses Formex XML (fmx4) for structured parsing of articles and recitals.
 * No WAF issues — Cellar is a machine-readable API.
 */
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

import { unzipLargestXml } from "../zip.js";

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
      return unzipLargestXml(new Uint8Array(buf));
    }
  }
  throw new Error(`Cellar fetch failed for ${manifestationUrl}`);
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

export const eurlexProvider: LawSyncProvider = {
  id: "eurlex",
  supportedLanguages: Object.keys(LANG_MAP),

  async fetchLaw(config: LawConfig, lang?: string): Promise<SyncResult> {
    if (!config.celex) throw new Error(`Missing celex for ${config.slug}`);
    const targetLang = lang ?? config.lang;
    const url = await findFormexUrl(config.celex, targetLang);
    if (!url) throw new Error(`No Formex manifestation found for ${config.celex} in ${targetLang}`);
    const xml = await fetchFormex(url);

    const provisions: Provision[] = [];
    const toc: TocNode[] = [];
    const stack: { depth: number; node: TocNode }[] = [];

    // Parse ARTICLE elements
    const articleRe = /<ARTICLE IDENTIFIER="(\d+\w*)">([\s\S]*?)<\/ARTICLE>/gi;
    let m: RegExpExecArray | null;
    while ((m = articleRe.exec(xml))) {
      const nr = m[1]!.replace(/^0+/, ""); // strip leading zeros (Formex uses 001, 002, ...)
      const body = m[2]!;
      const tiMatch = body.match(/<STI\.ART>([^<]*)<\/STI\.ART>/);
      const title = tiMatch ? tiMatch[1]!.trim() : "";
      const text = fmxToMarkdown(body);
      if (!text) continue;
      provisions.push({ nr, title, text });
      const provNode: TocNode = { nr, title };
      if (stack.length) stack[stack.length - 1]!.node.children!.push(provNode);
      else toc.push(provNode);
    }

    // Parse DIVISION/TITLE for TOC structure (chapters, sections)
    // Re-parse to build proper hierarchy
    const divRe = /<DIVISION>([\s\S]*?)<\/DIVISION>/gi;
    // For now, flat article list is sufficient — structure can be enhanced later

    return { provisions, toc };
  },

  async fetchSupplement(config: LawConfig, _type: string, _supplementCfg: SupplementConfig, lang?: string): Promise<SupplementResult> {
    if (!config.celex) throw new Error(`Missing celex for ${config.slug}`);
    const targetLang = lang ?? config.lang;
    const url = await findFormexUrl(config.celex, targetLang);
    if (!url) throw new Error(`No Formex manifestation found for ${config.celex} in ${targetLang}`);
    const xml = await fetchFormex(url);

    const items: SupplementItem[] = [];

    // Parse CONSID elements (recitals in the preamble)
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
