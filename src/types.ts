export interface TocNode {
  label?: string;
  title: string;
  nr?: string;
  children?: TocNode[];
}

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
  source: string;
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

export interface LawSyncProvider {
  id: string;
  fetchLaw(config: LawConfig): Promise<SyncResult>;
  fetchSupplement?(config: LawConfig, type: string, supplementCfg: SupplementConfig): Promise<SupplementResult>;
}
