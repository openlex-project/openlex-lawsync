/**
 * GII Provider — syncs German federal laws from gesetze-im-internet.de.
 * Fetches XML zip archives, parses norm elements, converts to Markdown.
 */
import { unzipLargestXml } from "../zip.js";
import type { LawSyncProvider, LawConfig, SyncResult, TocNode, Provision } from "../types.js";
import { log } from "../log.js";

const GII_URL = "https://www.gesetze-im-internet.de/{slug}/xml.zip";

/** Fetch and decompress the XML zip archive from GII. */
async function fetchXml(slug: string): Promise<string> {
  const url = GII_URL.replace("{slug}", slug);
  log.info(`  Fetching ${url}`);
  const res = await fetch(url, { headers: { "User-Agent": "openlex-lawsync/1.0" }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`GII fetch failed: ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  return unzipLargestXml(buf);
}

/** Extract text content of an XML tag (first match). */
function xmlText(xml: string, tag: string): string {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i");
  const m = xml.match(re);
  return m ? m[1]!.trim() : "";
}

/** Convert GII XML content elements to Markdown (bold, italic, lists, cleanup). */
function contentToMarkdown(content: string): string {
  return content
    .replace(/<P[^>]*>/gi, "\n\n").replace(/<\/P>/gi, "")
    .replace(/<BR\s*\/?>/gi, "\n")
    .replace(/<B[^>]*>([\s\S]*?)<\/B>/gi, "**$1**")
    .replace(/<I[^>]*>([\s\S]*?)<\/I>/gi, "*$1*")
    .replace(/<DL[^>]*>/gi, "\n\n").replace(/<\/DL>/gi, "")
    .replace(/<DT[^>]*>/gi, "\n").replace(/<\/DT>/gi, " ")
    .replace(/<DD[^>]*>/gi, "").replace(/<\/DD>/gi, "")
    .replace(/<LA[^>]*>/gi, "").replace(/<\/LA>/gi, "")
    .replace(/<F[^>]*>([\s\S]*?)<\/F>/gi, "$1")
    .replace(/<SP[^>]*>([\s\S]*?)<\/SP>/gi, "$1")
    .replace(/<FnR[^>]*>[\s\S]*?<\/FnR>/gi, "")
    .replace(/<Footnotes[\s\S]*?<\/Footnotes>/gi, "")
    .replace(/<noindex[\s\S]*?<\/noindex>/gi, "")
    .replace(/<TOC[\s\S]*?<\/TOC>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

/** Extract provision number from enbez string (e.g., "§ 1" → "1", "Art 5" → "5"). */
function extractNr(enbez: string, unitType: string): string | null {
  if (enbez.includes("(XXXX)")) return null;
  const re = unitType === "section" ? /§\s*(\d+\w*)/ : /Art\.?\s*(\d+\w*)/;
  const m = enbez.match(re);
  return m ? m[1]! : null;
}

export const giiProvider: LawSyncProvider = {
  id: "gii",
  supportedLanguages: ["de"],

  async fetchLaw(config: LawConfig): Promise<SyncResult> {
    const slug = config.gii_slug ?? config.slug;
    const xml = await fetchXml(slug);
    const provisions: Provision[] = [];
    const toc: TocNode[] = [];
    const stack: { depth: number; node: TocNode }[] = [];

    // Parse norms
    const normRe = /<norm[^>]*>([\s\S]*?)<\/norm>/gi;
    let m: RegExpExecArray | null;
    while ((m = normRe.exec(xml))) {
      const norm = m[1]!;
      const meta = xmlText(norm, "metadaten");

      // Structure node (gliederungseinheit)
      const glMatch = meta.match(/<gliederungseinheit>([\s\S]*?)<\/gliederungseinheit>/);
      if (glMatch) {
        const gl = glMatch[1]!;
        const bez = xmlText(gl, "gliederungsbez");
        const kz = xmlText(gl, "gliederungskennzahl");
        const title = xmlText(gl, "gliederungstitel").replace(/\n/g, " ");
        const node: TocNode = { label: bez, title, children: [] };
        const depth = Math.floor(kz.length / 3);
        while (stack.length >= depth) stack.pop();
        if (stack.length) stack[stack.length - 1]!.node.children!.push(node);
        else toc.push(node);
        stack.push({ depth, node });
        continue;
      }

      // Provision
      const enbez = xmlText(meta, "enbez");
      if (!enbez) continue;
      const nr = extractNr(enbez, config.unit_type);
      if (!nr) continue;
      const contentMatch = norm.match(/<Content>([\s\S]*?)<\/Content>/);
      if (!contentMatch) continue;
      const text = contentToMarkdown(contentMatch[1]!);
      if (!text || text === "-") continue;
      const title = xmlText(meta, "titel");
      provisions.push({ nr, title, text });
      const provNode: TocNode = { nr, title };
      if (stack.length) stack[stack.length - 1]!.node.children!.push(provNode);
      else toc.push(provNode);
    }

    return { provisions, toc };
  },
};
