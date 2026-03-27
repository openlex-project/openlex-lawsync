/**
 * EUR-Lex Provider — syncs EU regulations from eur-lex.europa.eu.
 * Fetches consolidated HTML, parses eli-subdivision divs for articles,
 * and extracts numbered recitals from the preamble for supplements.
 */
import type { LawSyncProvider, LawConfig, SyncResult, SupplementConfig, SupplementResult, TocNode, Provision, SupplementItem } from "../types.js";

const EURLEX_URL = "https://eur-lex.europa.eu/legal-content/{lang}/TXT/HTML/?uri=CELEX:{celex}";

async function fetchHtml(celex: string, lang: string): Promise<string> {
  const url = EURLEX_URL.replace("{celex}", celex).replace("{lang}", lang.toUpperCase());
  console.log(`  Fetching ${url}`);
  const res = await fetch(url, { headers: { "User-Agent": "openlex-lawsync/1.0" } });
  if (!res.ok) throw new Error(`EUR-Lex fetch failed: ${res.status}`);
  return res.text();
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, "").trim();
}

function divToMarkdown(html: string): string {
  const parts: string[] = [];
  // Paragraphs
  const pRe = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let m: RegExpExecArray | null;
  while ((m = pRe.exec(html))) {
    const text = stripTags(m[1]!).replace(/\s+/g, " ").trim();
    if (text) parts.push(text);
  }
  // Tables (EUR-Lex uses tables for lettered lists)
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  while ((m = trRe.exec(html))) {
    const cells = [...m[1]!.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => stripTags(c[1]!).trim());
    if (cells.length === 2 && cells[0] && cells[1]) parts.push(`${cells[0]} ${cells[1]}`);
  }
  return parts.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
}

export const eurlexProvider: LawSyncProvider = {
  id: "eurlex",
  supportedLanguages: ["bg", "cs", "da", "de", "el", "en", "es", "et", "fi", "fr", "ga", "hr", "hu", "it", "lt", "lv", "mt", "nl", "pl", "pt", "ro", "sk", "sl", "sv"],

  async fetchLaw(config: LawConfig, lang?: string): Promise<SyncResult> {
    if (!config.celex) throw new Error(`Missing celex for ${config.slug}`);
    const html = await fetchHtml(config.celex, lang ?? config.lang);
    const provisions: Provision[] = [];
    const toc: TocNode[] = [];
    const stack: { level: number; node: TocNode }[] = [];

    // Parse eli-subdivision divs
    const divRe = /<div[^>]*class="eli-subdivision"[^>]*id="([^"]*)"[^>]*>([\s\S]*?)(?=<div[^>]*class="eli-subdivision"|$)/gi;
    let m: RegExpExecArray | null;
    while ((m = divRe.exec(html))) {
      const id = m[1]!;
      const content = m[2]!;

      // Article
      const artMatch = id.match(/^art_(\d+\w*)$/);
      if (artMatch) {
        const nr = artMatch[1]!;
        const stiMatch = content.match(/<p[^>]*class="oj-sti-art"[^>]*>([\s\S]*?)<\/p>/i);
        const title = stiMatch ? stripTags(stiMatch[1]!) : "";
        // Remove title elements before extracting body
        const body = content
          .replace(/<p[^>]*class="oj-ti-art"[^>]*>[\s\S]*?<\/p>/gi, "")
          .replace(/<p[^>]*class="oj-sti-art"[^>]*>[\s\S]*?<\/p>/gi, "")
          .replace(/<div[^>]*class="eli-title"[^>]*>[\s\S]*?<\/div>/gi, "");
        const text = divToMarkdown(body);
        if (!text) continue;
        provisions.push({ nr, title, text });
        const provNode: TocNode = { nr, title };
        if (stack.length) stack[stack.length - 1]!.node.children!.push(provNode);
        else toc.push(provNode);
        continue;
      }

      // Structure (chapter/section)
      const strMatch = id.match(/^(chp|cpt|sec|tit)_(\w+)$/);
      if (strMatch) {
        const levelMap: Record<string, number> = { chp: 1, cpt: 1, tit: 2, sec: 2 };
        const level = levelMap[strMatch[1]!] ?? 1;
        const tiMatch = content.match(/<p[^>]*class="oj-ti-grseq[^"]*"[^>]*>([\s\S]*?)<\/p>/i);
        const stiMatch = content.match(/<p[^>]*class="oj-sti-grseq[^"]*"[^>]*>([\s\S]*?)<\/p>/i);
        const label = tiMatch ? stripTags(tiMatch[1]!) : "";
        const title = stiMatch ? stripTags(stiMatch[1]!) : "";
        const node: TocNode = { label, title, children: [] };
        while (stack.length >= level) stack.pop();
        if (stack.length) stack[stack.length - 1]!.node.children!.push(node);
        else toc.push(node);
        stack.push({ level, node });
      }
    }

    return { provisions, toc };
  },

  async fetchSupplement(config: LawConfig, _type: string, _supplementCfg: SupplementConfig, lang?: string): Promise<SupplementResult> {
    if (!config.celex) throw new Error(`Missing celex for ${config.slug}`);
    const html = await fetchHtml(config.celex, lang ?? config.lang);
    const items: SupplementItem[] = [];

    // Parse recitals — they're numbered paragraphs in the preamble
    const recitalRe = /<p[^>]*class="oj-normal"[^>]*>\s*\((\d+)\)\s*([\s\S]*?)<\/p>/gi;
    let m: RegExpExecArray | null;
    while ((m = recitalRe.exec(html))) {
      const nr = m[1]!;
      const text = stripTags(m[2]!).replace(/\s+/g, " ").trim();
      if (text) items.push({ nr, text });
    }

    return { items };
  },
};
