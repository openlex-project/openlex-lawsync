#!/usr/bin/env node
import { sync } from "./sync.js";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const lawIdx = args.indexOf("--law");
const law = lawIdx >= 0 ? args[lawIdx + 1] : undefined;

async function main() {
  console.log(`openlex-lawsync${dryRun ? " (dry run)" : ""}${law ? ` — law: ${law}` : ""}\n`);
  try {
    const { changed, total } = await sync({ dryRun, law });
    console.log(`\nDone. ${changed} of ${total} files changed.`);
    process.exit(changed > 0 ? 0 : 0);
  } catch (err) {
    console.error("Sync failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

main();
