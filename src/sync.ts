import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import type { SyncYaml, LawConfig } from "./types.js";
import { getProvider } from "./providers/index.js";
import { parse } from "yaml";

export interface SyncOptions {
  cwd?: string;
  dryRun?: boolean;
  law?: string;
}

export async function sync(opts: SyncOptions = {}): Promise<{ changed: number; total: number }> {
  const cwd = opts.cwd ?? process.cwd();
  const raw = readFileSync(join(cwd, "sync.yaml"), "utf-8");
  const config = parse(raw) as SyncYaml;
  let changed = 0;
  let total = 0;

  for (const [slug, lawCfg] of Object.entries(config.laws)) {
    if (opts.law && opts.law !== slug) continue;
    const law: LawConfig = { slug, ...lawCfg };
    console.log(`Syncing ${slug} (${law.title_short ?? slug})...`);

    const provider = getProvider(law.source);
    const result = await provider.fetchLaw(law);
    const dir = join(cwd, slug);
    mkdirSync(dir, { recursive: true });

    // Write provisions
    const existing = new Set(existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md")) : []);
    const written = new Set<string>();

    for (const p of result.provisions) {
      const fname = `${p.nr}.md`;
      written.add(fname);
      const fpath = join(dir, fname);
      const text = p.text.endsWith("\n") ? p.text : p.text + "\n";
      total++;
      if (existsSync(fpath) && readFileSync(fpath, "utf-8") === text) continue;
      if (opts.dryRun) { console.log(`  [dry-run] Would write ${slug}/${fname}`); changed++; continue; }
      writeFileSync(fpath, text, "utf-8");
      changed++;
    }

    // Remove deleted provisions
    for (const old of existing) {
      if (!written.has(old)) {
        if (opts.dryRun) { console.log(`  [dry-run] Would remove ${slug}/${old}`); }
        else { unlinkSync(join(dir, old)); console.log(`  Removed ${slug}/${old}`); }
      }
    }

    // Write toc.yaml
    if (!opts.dryRun) {
      writeFileSync(join(dir, "toc.yaml"), stringify(result.toc, { lineWidth: 0 }), "utf-8");
    }

    // Supplements
    if (law.supplements && provider.fetchSupplement) {
      for (const [type, supplementCfg] of Object.entries(law.supplements)) {
        console.log(`  Syncing supplement: ${type}`);
        const suppResult = await provider.fetchSupplement(law, type, supplementCfg);
        const suppDir = join(dir, type);
        mkdirSync(suppDir, { recursive: true });

        for (const item of suppResult.items) {
          const fname = `${item.nr}.md`;
          const fpath = join(suppDir, fname);
          const text = item.text.endsWith("\n") ? item.text : item.text + "\n";
          if (existsSync(fpath) && readFileSync(fpath, "utf-8") === text) continue;
          if (opts.dryRun) { console.log(`  [dry-run] Would write ${slug}/${type}/${fname}`); changed++; continue; }
          writeFileSync(fpath, text, "utf-8");
          changed++;
        }
        console.log(`  ${suppResult.items.length} ${type} synced`);
      }
    }

    console.log(`  ${changed} files updated`);
  }

  return { changed, total };
}
