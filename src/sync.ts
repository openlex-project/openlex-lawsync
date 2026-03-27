/**
 * Core sync engine.
 * Reads sync.yaml, dispatches to providers, writes .md + toc.yaml files.
 * Each law is synced independently — a failure in one law does not block others.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { stringify, parse } from "yaml";
import type { SyncYaml, LawConfig } from "./types.js";
import { getProvider } from "./providers/index.js";
import { log } from "./log.js";

export interface SyncOptions {
  /** Working directory containing sync.yaml. Defaults to cwd. */
  cwd?: string;
  /** Preview changes without writing files. */
  dryRun?: boolean;
  /** Sync only this law slug. */
  law?: string;
}

export interface SyncReport {
  changed: number;
  total: number;
  errors: string[];
}

/** Maximum retries per provider fetch on transient errors. */
const MAX_RETRIES = 2;

/** Retry a function with exponential backoff on failure. */
async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === MAX_RETRIES) throw err;
      const delay = 1000 * 2 ** attempt;
      log.warn("%s failed (attempt %s/%s), retrying in %sms: %s", label, attempt + 1, MAX_RETRIES + 1, delay, err instanceof Error ? err.message : err);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error("unreachable");
}

/** Write a file only if content changed. Returns true if written. */
function writeIfChanged(path: string, content: string, dryRun?: boolean): boolean {
  if (existsSync(path) && readFileSync(path, "utf-8") === content) return false;
  if (dryRun) { log.info("[dry-run] Would write %s", path); return true; }
  writeFileSync(path, content, "utf-8");
  return true;
}

/**
 * Run the sync process.
 * Reads sync.yaml from `opts.cwd`, fetches laws from configured providers,
 * writes Markdown files + toc.yaml, and handles supplements (e.g., recitals).
 */
export async function sync(opts: SyncOptions = {}): Promise<SyncReport> {
  const cwd = opts.cwd ?? process.cwd();
  const raw = readFileSync(join(cwd, "sync.yaml"), "utf-8");
  const config = parse(raw) as SyncYaml;
  const report: SyncReport = { changed: 0, total: 0, errors: [] };

  for (const [slug, lawCfg] of Object.entries(config.laws)) {
    if (opts.law && opts.law !== slug) continue;
    const law: LawConfig = { slug, ...lawCfg };

    try {
      log.info("Syncing %s (%s)...", slug, law.title_short ?? slug);
      const provider = getProvider(law.source);

      // Fetch law provisions with retry
      const result = await withRetry(`${slug}/fetchLaw`, () => provider.fetchLaw(law));
      const dir = join(cwd, slug);
      mkdirSync(dir, { recursive: true });

      // Track existing files for cleanup
      const existing = new Set(existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md")) : []);
      const written = new Set<string>();

      // Write provision files
      for (const p of result.provisions) {
        const fname = `${p.nr}.md`;
        written.add(fname);
        const text = p.text.endsWith("\n") ? p.text : p.text + "\n";
        report.total++;
        if (writeIfChanged(join(dir, fname), text, opts.dryRun)) report.changed++;
      }

      // Remove files for repealed/deleted provisions
      for (const old of existing) {
        if (!written.has(old)) {
          if (opts.dryRun) log.info("[dry-run] Would remove %s/%s", slug, old);
          else { unlinkSync(join(dir, old)); log.info("Removed %s/%s", slug, old); }
        }
      }

      // Write toc.yaml
      if (!opts.dryRun) {
        writeFileSync(join(dir, "toc.yaml"), stringify(result.toc, { lineWidth: 0 }), "utf-8");
      }

      // Sync supplements (e.g., recitals)
      if (law.supplements && provider.fetchSupplement) {
        for (const [type, supplementCfg] of Object.entries(law.supplements)) {
          try {
            log.info("  Syncing supplement: %s", type);
            const suppResult = await withRetry(`${slug}/${type}`, () => provider.fetchSupplement!(law, type, supplementCfg));
            const suppDir = join(dir, type);
            mkdirSync(suppDir, { recursive: true });

            for (const item of suppResult.items) {
              const text = item.text.endsWith("\n") ? item.text : item.text + "\n";
              if (writeIfChanged(join(suppDir, `${item.nr}.md`), text, opts.dryRun)) report.changed++;
            }
            log.info("  %s %s synced", suppResult.items.length, type);
          } catch (err) {
            const msg = `${slug}/${type}: ${err instanceof Error ? err.message : err}`;
            log.error("Supplement sync failed: %s", msg);
            report.errors.push(msg);
          }
        }
      }

      log.info("  %s provisions, %s changed", result.provisions.length, report.changed);
    } catch (err) {
      const msg = `${slug}: ${err instanceof Error ? err.message : err}`;
      log.error("Law sync failed: %s", msg);
      report.errors.push(msg);
    }
  }

  return report;
}
