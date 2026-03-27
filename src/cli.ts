#!/usr/bin/env node
/**
 * CLI entry point for openlex-lawsync.
 * Usage: npx openlex-lawsync [--dry-run] [--law <slug>]
 */
import { sync } from "./sync.js";
import { log } from "./log.js";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const lawIdx = args.indexOf("--law");
const law = lawIdx >= 0 ? args[lawIdx + 1] : undefined;

async function main() {
  log.info("openlex-lawsync%s%s", dryRun ? " (dry run)" : "", law ? ` — law: ${law}` : "");
  const report = await sync({ dryRun, law });
  log.info("Done. %s of %s files changed.", report.changed, report.total);
  if (report.errors.length) {
    log.warn("%s errors occurred:", report.errors.length);
    for (const e of report.errors) log.error("  %s", e);
    process.exit(1);
  }
}

main().catch((err) => { log.error("Fatal: %s", err instanceof Error ? err.message : err); process.exit(1); });
