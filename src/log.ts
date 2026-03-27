/** Structured logger with levels. Defaults to "info". Set LOG_LEVEL env var to change. */

type Level = "debug" | "info" | "warn" | "error";
const LEVELS: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const current = LEVELS[(process.env.LOG_LEVEL as Level) ?? "info"] ?? 1;

function fmt(level: Level, msg: string, ...args: unknown[]): string {
  const ts = new Date().toISOString();
  const filled = args.reduce<string>((s, a) => s.replace("%s", String(a)), msg);
  return `${ts} [${level.toUpperCase()}] ${filled}`;
}

export const log = {
  debug: (msg: string, ...args: unknown[]) => { if (current <= 0) console.log(fmt("debug", msg, ...args)); },
  info: (msg: string, ...args: unknown[]) => { if (current <= 1) console.log(fmt("info", msg, ...args)); },
  warn: (msg: string, ...args: unknown[]) => { if (current <= 2) console.warn(fmt("warn", msg, ...args)); },
  error: (msg: string, ...args: unknown[]) => { console.error(fmt("error", msg, ...args)); },
};
