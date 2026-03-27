# openlex-lawsync

Extensible law sync tool for [OpenLex](https://github.com/openlex-project/openlex). Fetches legal texts from official sources, converts to Markdown, and commits changes to your law repository.

Available as a CLI and as a reusable GitHub Action.

## Providers

| Provider | Source | Status |
|---|---|---|
| `gii` | [gesetze-im-internet.de](https://www.gesetze-im-internet.de) (German federal law) | ✅ |
| `eurlex` | [EUR-Lex](https://eur-lex.europa.eu) (EU regulations, incl. recitals) | ✅ |
| `ris` | [Rechtsinformationssystem](https://www.recht.bund.de) (German federal, test) | Planned |

## Usage

### GitHub Action

```yaml
# .github/workflows/sync.yml
name: Sync Laws
on:
  schedule:
    - cron: "0 4 * * *"
  workflow_dispatch:

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: openlex-project/openlex-lawsync@v1
        with:
          deploy-hook: ${{ secrets.VERCEL_DEPLOY_HOOK }}
```

### CLI

```bash
npx openlex-lawsync          # reads sync.yaml in current directory
npx openlex-lawsync --dry-run # preview changes without writing
```

## sync.yaml

```yaml
laws:
  dsgvo:
    title: "Datenschutz-Grundverordnung"
    title_short: "DSGVO"
    unit_type: "article"
    lang: "de"
    license: "LicenseRef-PublicDomain"
    source: "eurlex"
    celex: "32016R0679"
    feedback: true
    supplements:
      recitals:
        label: { de: "Erwägungsgründe", en: "Recitals" }
        source: eurlex
        mapping:
          5: [39]
          7: [32, 33, 42, 43]

  bgb:
    title: "Bürgerliches Gesetzbuch"
    title_short: "BGB"
    unit_type: "section"
    lang: "de"
    license: "LicenseRef-PublicDomain"
    source: "gii"
    gii_slug: "bgb"
    feedback: true
```

See the [OpenLex sync.yaml docs](https://github.com/openlex-project/openlex/blob/main/docs/sync-yaml.md) for full reference.

## Adding a Provider

```typescript
import type { LawSyncProvider } from "./types";

export const myProvider: LawSyncProvider = {
  id: "my-source",
  async fetchLaw(config) {
    // Fetch and parse law text
    return { provisions: [...], toc: [...] };
  },
  async fetchSupplements(config, type) {
    // Fetch supplementary content (recitals, reasoning, etc.)
    return { items: [...] };
  },
};
```

Register in `src/providers/index.ts` and use `source: "my-source"` in sync.yaml.

## License

AGPL-3.0 — see [LICENSE](LICENSE).

Part of the [OpenLex](https://github.com/openlex-project/openlex) project.
