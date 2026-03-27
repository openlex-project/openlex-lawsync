import type { LawSyncProvider } from "../types.js";
import { giiProvider } from "./gii.js";
import { eurlexProvider } from "./eurlex.js";

const providers = new Map<string, LawSyncProvider>([
  ["gii", giiProvider],
  ["eurlex", eurlexProvider],
]);

export function getProvider(id: string): LawSyncProvider {
  const p = providers.get(id);
  if (!p) throw new Error(`Unknown provider: ${id}. Available: ${[...providers.keys()].join(", ")}`);
  return p;
}
