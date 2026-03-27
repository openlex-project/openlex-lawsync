/** Normalize i18n field: plain string → { [lang]: value }, object → passthrough. */
export function normalizeI18n(val: unknown, lang: string): Record<string, string> {
  if (typeof val === "string") return { [lang]: val };
  if (val && typeof val === "object" && !Array.isArray(val)) return val as Record<string, string>;
  return {};
}

/** Resolve an i18n record to a single string. */
export function resolveI18n(val: Record<string, string> | undefined, lang: string): string {
  if (!val) return "";
  return val[lang] ?? val["en"] ?? Object.values(val)[0] ?? "";
}
