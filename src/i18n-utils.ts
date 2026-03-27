/**
 * i18n utilities for YAML fields.
 *
 * All user-facing string fields accept either:
 * - A plain string (shorthand for default_locale)
 * - An object with locale keys: { de: "...", en: "..." }
 */

export type I18nString = Record<string, string>;

/** Normalize a YAML field: plain string → { [lang]: value }, object → passthrough. */
export function normalizeI18n(val: unknown, lang: string): I18nString {
  if (typeof val === "string") return { [lang]: val };
  if (val && typeof val === "object" && !Array.isArray(val)) return val as I18nString;
  return {};
}

/** Resolve an i18n record to a single string for the given language. */
export function resolveI18n(val: I18nString | undefined, lang: string): string {
  if (!val) return "";
  return val[lang] ?? val["en"] ?? Object.values(val)[0] ?? "";
}
