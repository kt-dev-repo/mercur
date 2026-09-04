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
npm install --force   # npm, not bun — bun's linker breaks Medusa's node_modules layout
npm run codegen       # required once after install, and after any route change
npm run dev
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

## Verifying a change

```bash
npm run codegen && npm run check-types && npm run lint
npm run test:unit --workspace @acme/api
npm run test:integration:http --workspace @acme/api   # needs Postgres + Redis
```

CI runs all of this on every push, and `deploy/smoke-test.sh` — the end-to-end check for
the deployment — on pull requests. See the repository README for how to start the test
databases.

Two properties of the Medusa test runner mislead you if you do not know them. Both look
like a broken API rather than what they are:

- It reads **`DB_HOST` / `DB_PORT` / `DB_USERNAME` / `DB_PASSWORD`**, not `DATABASE_URL`,
  to create the per-run database. Set only `DATABASE_URL` and it tries `localhost:5432`
  and fails with a bare `AggregateError`.
- It **restores the database between `it` blocks**. `beforeAll` fixtures survive via a
  snapshot; rows created inside a test do not. Split a flow across several tests and the
  second one 404s on what the first just created. Keep such a flow in one `it`.

## Changing anything under `deploy/`

`deploy/` holds a Dockerfile, a Compose stack, a production config overlay, a backup
sidecar and the smoke suite. `deploy/README.md` is the operator-facing guide and is
expected to stay accurate — several defects in this project were documentation drifting
away from behaviour, not code. If you change a setting, change the guide and
`deploy/.env.example` in the same commit, and add an assertion to `deploy/smoke-test.sh`
if the change has a failure mode worth catching.
