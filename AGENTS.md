# Mercur Marketplace Project

**This is a Mercur marketplace project — an open-source AI-native multi-vendor marketplace built on MedusaJS v2.**

## Read the docs first

Before any non-trivial change, read the **bundled documentation** — it ships as a dependency, so it is offline and version-matched to this project's packages:

1. Index: `node_modules/@mercurjs/docs/llms.txt`
2. Full pages: `node_modules/@mercurjs/docs/content/**/*.mdx`

It covers the domain model (sellers, products, offers, attributes, commissions, payouts, order groups), the CLI, the typed API client, the dashboard SDK, and module references. Don't guess at an API or data model the docs already describe.

### Project Structure

```
├── packages/api/         # Backend API — modules, workflows, links, subscribers
├── apps/admin/           # Admin dashboard — operator panel
├── apps/vendor/          # Vendor portal — seller dashboard
└── blocks.json           # Block configuration and registry aliases
```

## Documentation

- **Bundled docs (read first)**: `node_modules/@mercurjs/docs/llms.txt` → `content/**/*.mdx`
- **Online docs**: https://docs.mercurjs.com
- **MCP Server**: https://docs.mercurjs.com/mcp — connect your AI agent for documentation search
- **llms.txt (online)**: https://docs.mercurjs.com/llms.txt

## Configuration Files

- `blocks.json` — block configuration and registry path aliases
- `packages/api/medusa-config.ts` — MedusaJS configuration
- `apps/admin/vite.config.ts` — admin dashboard build config
- `apps/vendor/vite.config.ts` — vendor portal build config

## Getting Started

```bash
bun install
bun run codegen   # required once after install, and after any route change
bun run dev
```

`codegen` writes `packages/api/.mercur/routes.d.ts`. Both panels import their route
types from `@acme/api/_generated`, which resolves to that file, so `build` and
`check-types` fail with `Cannot find module '@acme/api/_generated'` until it exists.
It cannot run as part of `build`: Turborepo builds the panels *before* `packages/api`
(they are its `^build` dependencies), so codegen has to happen ahead of the graph.

This starts:

- Backend API at `http://localhost:9000`
- Admin Panel at `http://localhost:9000/dashboard` (standalone Vite dev server on `http://localhost:7000`)
- Vendor Panel at `http://localhost:9000/seller` (standalone Vite dev server on `http://localhost:7001`)

The panel paths come from the `admin-ui` and `vendor-ui` module options in
`packages/api/medusa-config.ts`; `packages/api/scripts/bundle-dashboards.mjs`
must be kept in sync with them.
