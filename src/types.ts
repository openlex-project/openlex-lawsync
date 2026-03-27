/** Table of contents node — either a structure heading or a provision reference. */
export interface TocNode {
  label?: string;
  title: string;
  nr?: string;
  children?: TocNode[];
}

/** A single law provision (paragraph/article) with its text as Markdown. */
export interface Provision {
  nr: string;
  title: string;
  text: string;
}

export interface SyncResult {
  provisions: Provision[];
  toc: TocNode[];
}

export interface SupplementItem {
  nr: string;
  text: string;
}

export interface SupplementResult {
  items: SupplementItem[];
}

export interface SupplementConfig {
  label: Record<string, string>;
  title_short: string;
  source: string;
  prefix: string;
  mapping: Record<string, number[]>;
}

export interface LawConfig {
  slug: string;
  title: string;
  title_short?: string;
  unit_type: "article" | "section";
  lang: string;
  license?: string;
  category?: string;
  source: string;
  feedback?: boolean;
  translations?: string[];
  // GII-specific
  gii_slug?: string;
  // EUR-Lex-specific
  celex?: string;
  // Supplements
  supplements?: Record<string, SupplementConfig>;
}

export interface SyncYaml {
  laws: Record<string, Omit<LawConfig, "slug">>;
}

/**
 * Provider interface for law sync sources.
 * Implement this to add a new source (e.g., RIS, Landesrecht).
 */
export interface LawSyncProvider {
  id: string;
  /** Which languages this provider supports. Empty = only default lang. */
  supportedLanguages?: string[];
  fetchLaw(config: LawConfig, lang?: string): Promise<SyncResult>;
  fetchSupplement?(config: LawConfig, type: string, supplementCfg: SupplementConfig, lang?: string): Promise<SupplementResult>;
}
