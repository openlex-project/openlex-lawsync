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
      - uses: actions/checkout@v6
      - uses: openlex-project/openlex-lawsync@main
        with:
          deploy-hook: ${{ secrets.VERCEL_DEPLOY_HOOK }}
          gii-proxy-url: "https://gii-proxy.lexict.workers.dev"
          gii-proxy-token: ${{ secrets.GII_PROXY_TOKEN }}
```

> **Note:** gesetze-im-internet.de blocks GitHub Actions IPs. The `gii-proxy-url` and `gii-proxy-token` inputs route GII requests through a Cloudflare Worker proxy. See [GII Proxy](#gii-proxy) below.

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
        title_short: { de: "EG", en: "Rec." }
        source: eurlex
        prefix: "rec"
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

## GII Proxy

gesetze-im-internet.de drops TCP connections from GitHub Actions IP ranges. The `proxy/` directory contains a Cloudflare Worker that proxies GII requests, secured with a Bearer token.

**Deploy:**

```bash
cd proxy
wrangler deploy
echo "your-secret-token" | wrangler secret put PROXY_TOKEN
```

Then set `GII_PROXY_TOKEN` as a GitHub Actions secret on your law repository.

Without the proxy, GII laws (BGB, StGB, etc.) will fail on GitHub Actions but still work when running the CLI locally.

## License

AGPL-3.0 — see [LICENSE](LICENSE).

Part of the [OpenLex](https://github.com/openlex-project/openlex) project.
