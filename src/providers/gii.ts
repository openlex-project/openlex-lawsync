/**
 * GII Provider — syncs German federal laws from gesetze-im-internet.de.
 * Fetches XML zip archives, parses norm elements, converts to Markdown.
 */
import { Buffer } from "node:buffer";
import type { LawSyncProvider, LawConfig, SyncResult, TocNode, Provision } from "../types.js";

const GII_URL = "https://www.gesetze-im-internet.de/{slug}/xml.zip";

async function fetchXml(slug: string): Promise<string> {
  const url = GII_URL.replace("{slug}", slug);
  console.log(`  Fetching ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GII fetch failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  // ZIP: find first file, decompress (ZIP is simple enough for single-file archives)
  const { Readable } = await import("node:stream");
  const { createUnzip } = await import("node:zlib");
  const { pipeline } = await import("node:stream/promises");

  // Minimal ZIP parsing: find local file header, extract compressed data
  let offset = 0;
  while (offset < buf.length - 4) {
    if (buf.readUInt32LE(offset) === 0x04034b50) { // local file header
      const compMethod = buf.readUInt16LE(offset + 8);
      const fnLen = buf.readUInt16LE(offset + 26);
      const extraLen = buf.readUInt16LE(offset + 28);
      const dataStart = offset + 30 + fnLen + extraLen;
      const compSize = buf.readUInt32LE(offset + 18);
      const raw = buf.subarray(dataStart, dataStart + compSize);
      if (compMethod === 0) return raw.toString("utf-8"); // stored
      if (compMethod === 8) { // deflated
        const chunks: Buffer[] = [];
        const inflate = createUnzip();
        inflate.on("data", (c: Buffer) => chunks.push(c));
        await pipeline(Readable.from(raw), inflate);
        return Buffer.concat(chunks).toString("utf-8");
      }
    }
    offset++;
  }
  throw new Error("No file found in ZIP");
}

function xmlText(xml: string, tag: string): string {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i");
  const m = xml.match(re);
  return m ? m[1]!.trim() : "";
}

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

function extractNr(enbez: string, unitType: string): string | null {
  if (enbez.includes("(XXXX)")) return null;
  const re = unitType === "section" ? /§\s*(\d+\w*)/ : /Art\.?\s*(\d+\w*)/;
  const m = enbez.match(re);
  return m ? m[1]! : null;
}

export const giiProvider: LawSyncProvider = {
  id: "gii",

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
