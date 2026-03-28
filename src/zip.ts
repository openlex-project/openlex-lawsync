import { unzipSync } from "fflate";

/** Unzip and return the first XML matching a predicate, or the only XML if just one exists. */
export function unzipXml(buf: Uint8Array, match?: (name: string, data: Uint8Array) => boolean): string {
  const files = unzipSync(buf);
  const xmlEntries = Object.entries(files).filter(([n]) => n.endsWith(".xml"));
  if (!xmlEntries.length) throw new Error("No XML file found in ZIP");
  if (xmlEntries.length === 1) return new TextDecoder().decode(xmlEntries[0]![1]);
  if (match) {
    const found = xmlEntries.find(([n, d]) => match(n, d));
    if (found) return new TextDecoder().decode(found[1]);
  }
  throw new Error(`ZIP contains ${xmlEntries.length} XML files but no match found`);
}

/** Unzip and return all XMLs matching a predicate. */
export function unzipAllXml(buf: Uint8Array, match: (name: string, data: Uint8Array) => boolean): string[] {
  const files = unzipSync(buf);
  return Object.entries(files)
    .filter(([n, d]) => n.endsWith(".xml") && match(n, d))
    .map(([, d]) => new TextDecoder().decode(d));
}
