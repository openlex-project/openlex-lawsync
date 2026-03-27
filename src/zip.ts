import { unzipSync } from "fflate";

/** Extract the largest XML file from a ZIP buffer. */
export function unzipLargestXml(buf: Uint8Array): string {
  const files = unzipSync(buf);
  let best = "";
  let bestSize = 0;
  for (const [name, data] of Object.entries(files)) {
    if (name.endsWith(".xml") && data.length > bestSize) {
      best = name;
      bestSize = data.length;
    }
  }
  if (!best) throw new Error("No XML file found in ZIP");
  return new TextDecoder().decode(files[best]);
}
