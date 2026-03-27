/**
 * GII Provider — syncs German federal laws from gesetze-im-internet.de.
 * Fetches XML zip archives, parses norm elements, converts to Markdown.
 */
import { Buffer } from "node:buffer";
import type { LawSyncProvider, LawConfig, SyncResult, TocNode, Provision } from "../types.js";
import { log } from "../log.js";

const GII_URL = "https://www.gesetze-im-internet.de/{slug}/xml.zip";

/** Fetch and decompress the XML zip archive from GII. */
async function fetchXml(slug: string): Promise<string> {
  const url = GII_URL.replace("{slug}", slug);
  log.info(`  Fetching ${url}`);
  const res = await fetch(url, { headers: { "User-Agent": "openlex-lawsync/1.0" }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`GII fetch failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const { inflateRawSync } = await import("node:zlib");

  // Parse central directory (local headers may have 0 sizes due to data descriptors)
  let cdEnd = buf.length - 22;
  while (cdEnd > 0 && buf.readUInt32LE(cdEnd) !== 0x06054b50) cdEnd--;
  if (cdEnd <= 0) throw new Error("No central directory in ZIP");
  const cdOffset = buf.readUInt32LE(cdEnd + 16);
  const cdCount = buf.readUInt16LE(cdEnd + 10);

  // Find largest XML entry
  let best: { compMethod: number; compSize: number; localOffset: number } | null = null;
  let bestSize = 0;
  let pos = cdOffset;
  for (let i = 0; i < cdCount; i++) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) break;
    const compMethod = buf.readUInt16LE(pos + 10);
    const compSize = buf.readUInt32LE(pos + 20);
    const uncompSize = buf.readUInt32LE(pos + 24);
    const fnLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localOffset = buf.readUInt32LE(pos + 42);
    const name = buf.subarray(pos + 46, pos + 46 + fnLen).toString("utf-8");
    if (name.endsWith(".xml") && uncompSize > bestSize) {
      best = { compMethod, compSize, localOffset };
      bestSize = uncompSize;
    }
    pos += 46 + fnLen + extraLen + commentLen;
  }
  if (!best) throw new Error("No XML file found in ZIP");

  const lfhFnLen = buf.readUInt16LE(best.localOffset + 26);
  const lfhExtraLen = buf.readUInt16LE(best.localOffset + 28);
  const dataStart = best.localOffset + 30 + lfhFnLen + lfhExtraLen;
  const raw = buf.subarray(dataStart, dataStart + best.compSize);
  if (best.compMethod === 0) return raw.toString("utf-8");
  if (best.compMethod === 8) return inflateRawSync(raw).toString("utf-8");
  throw new Error(`Unsupported ZIP compression: ${best.compMethod}`);
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
