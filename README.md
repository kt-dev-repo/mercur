# Mercur Marketplace

A multi-vendor marketplace built on [Mercur](https://github.com/mercurjs/mercur) and
MedusaJS v2: a backend API, an admin console, a vendor panel, and a self-hosted
deployment stack for Dokploy.

It began as Mercur's `templates/basic` starter and has since grown a production
deployment (`deploy/`), CI, an integration and unit test suite, transactional email, and
Stripe payments and payouts. See [Relationship to upstream
Mercur](#relationship-to-upstream-mercur) for how it tracks the project it came from.

## Quick Start

To spin up this template locally, follow these steps:

### Clone

If you've already cloned this repo, skip to [Development](#development).

### Development

1. First [clone the repo](#clone) if you have not done so already

2. Copy the example environment variables:

```bash
cp packages/api/.env.template packages/api/.env
```

3. Update the `.env` file with your database connection string and other required variables:

```
DATABASE_URL=postgres://user:password@localhost:5432/mercur
REDIS_URL=redis://localhost:6379
JWT_SECRET=your-super-secret-jwt-key
COOKIE_SECRET=your-super-secret-cookie-key
```

4. Install dependencies, generate the route types, and start the dev server:

```bash
npm install --force
npm run codegen
npm run dev
```

   Install with npm, not bun: neither bun linker produces the workspace-hoisted
   `node_modules` layout Medusa needs, and the panels then fail to resolve their
   dependencies at build time. `--force` is needed because the root pins
   `react-hook-form@7.49.1` alongside `@hookform/resolvers@5.4.0`, which
   peer-requires `^7.55.0`; see `deploy/Dockerfile` for the full reasoning.

   `npm run codegen` is required once after a fresh install. It writes
   `packages/api/.mercur/routes.d.ts`, which both panels import as
   `@acme/api/_generated`; without it `npm run build` fails with
   `Cannot find module '@acme/api/_generated'`. Re-run it whenever you change a
   route. It is not part of `build` because Turborepo builds the panels before
   `packages/api`, so it has to run ahead of the build graph.

5. Open `http://localhost:9000` to access the Medusa backend
6. Open `http://localhost:7000` to access the admin dashboard
7. Open `http://localhost:7001` to access the vendor dashboard

   The backend also serves both panels: the admin panel at
   `http://localhost:9000/dashboard` and the vendor panel at
   `http://localhost:9000/seller`.

That's it! Follow the on-screen instructions to login and create your first admin user.

## What's Inside

This monorepo includes the following packages and apps:

### Apps and Packages

- `packages/api` - The Medusa backend with all marketplace functionality
- `apps/admin` - Admin dashboard customizations
- `apps/vendor` - Vendor portal customizations

### Project Structure

```
├── apps/
│   ├── admin/          # Admin dashboard extensions
│   └── vendor/         # Vendor portal extensions
├── packages/
│   └── api/            # Medusa backend
│       ├── src/
│       │   ├── api/         # Custom API routes
│       │   ├── jobs/        # Background jobs
│       │   ├── links/       # Module links
│       │   ├── modules/     # Custom modules
│       │   ├── scripts/     # CLI scripts
│       │   ├── subscribers/ # Event subscribers
│       │   └── workflows/   # Business workflows
│       └── medusa-config.ts
├── blocks.json         # Mercur blocks configuration
├── package.json
└── turbo.json
```

### Utilities

This project has some additional tools already setup for you:

- [TypeScript](https://www.typescriptlang.org/) for static type checking
- [Turborepo](https://turborepo.dev/) for monorepo management
- [Prettier](https://prettier.io) for code formatting

## How It Works

The Mercur basic template is built on top of [Medusa](https://medusajs.com) and is pre-configured for marketplace functionality.

### Modules

Custom modules allow you to extend the core functionality. See the [Modules](https://docs.medusajs.com/learn/fundamentals/modules) docs for details.

### Workflows

Workflows define multi-step business processes. See the [Workflows](https://docs.medusajs.com/learn/fundamentals/workflows) docs for details.

### API Routes

Custom API routes expose HTTP endpoints. See the [API Routes](https://docs.medusajs.com/learn/fundamentals/api-routes) docs for details.

### Links

Links define relationships between modules. See the [Links](https://docs.medusajs.com/learn/fundamentals/links) docs for details.

## Adding Blocks

You can extend your project with pre-built blocks using the Mercur CLI:

```bash
npx @mercurjs/cli add block-name
```

Configure your block sources in `blocks.json`. Each alias is a destination root that
installed block files are written into:

```json
{
  "$schema": "https://registry.mercurjs.com/registry.json",
  "aliases": {
    "api": "packages/api/src",
    "vendor": "apps/vendor/src",
    "admin": "apps/admin/src"
  },
  "registries": {}
}
```

## Build

To build all apps and packages:

```bash
npm run codegen   # once after install, or after changing a route
npm run build
```

To type-check every workspace without building:

```bash
npm run check-types
```

## Testing

```bash
npm run codegen                                    # once after install
npm run check-types && npm run lint
npm run test:unit --workspace @acme/api            # fast, no services needed
npm run test:integration:http --workspace @acme/api
```

Integration tests boot a real Medusa app against a real database, so Postgres and Redis
have to be running. The connection settings live in `packages/api/.env.test`, which is
committed because the credentials are throwaway and CI uses the same file:

```bash
docker run -d --name mercur-test-pg -p 5433:5432 \
  -e POSTGRES_USER=medusa -e POSTGRES_PASSWORD=medusa -e POSTGRES_DB=medusa-test postgres:16-alpine
docker run -d --name mercur-test-redis -p 6380:6379 redis:7-alpine
```

Two things about the test runner are worth knowing before you write a test, because both
present as a broken API rather than as what they are:

- **It reads `DB_HOST` / `DB_PORT` / `DB_USERNAME` / `DB_PASSWORD`, not `DATABASE_URL`**,
  to create and drop the per-run database. Set only `DATABASE_URL` and it silently tries
  `localhost:5432` and dies with a bare `AggregateError`.
- **It restores the database between `it` blocks.** Fixtures created in `beforeAll` survive
  via a snapshot; anything created *inside* a test does not. A flow split across several
  `it` blocks gives you a first test that passes and a second that 404s on the row the
  first just created. Keep a flow that builds on itself in one test.

The deployment has its own end-to-end suite — see [deploy/README.md](deploy/README.md).

## Continuous integration

`.github/workflows/ci.yml` runs on every push: typecheck and lint, then the three test
suites against Postgres and Redis service containers. Pull requests additionally run
`deploy/smoke-test.sh`, which builds the image and drives a full stack — boot guards,
both panels, a redeploy preserving data, backup round-trip, and the uploads migration.

## Relationship to upstream Mercur

This repository was **generated from** [`mercurjs/mercur`](https://github.com/mercurjs/mercur)'s
`templates/basic`. It is not a fork and shares no git history with it: upstream is the
library monorepo that publishes the `@mercurjs/*` packages, and this repository is a
consumer that installs them from npm.

That distinction decides how you take upstream changes.

### Upgrading Mercur

**Bump versions; never merge.** With no shared history a merge from upstream is
meaningless.

You do not have to watch for releases: `.github/workflows/upstream-check.yml` runs weekly,
compares the pinned versions against npm, and opens (or updates) a single issue when they
drift. To apply one:

```bash
npm run upgrade:mercur -- --mercur 2.3.4            # and/or --medusa 2.19.0
npm install --force
npm run codegen
```

Then run the full verification set under [Testing](#testing).

`scripts/bump-mercur.mjs` exists because the versions live in **three** places that must
move together — each workspace's dependencies, the root `overrides` (npm), and the root
`resolutions` (pnpm/yarn). Editing them by hand is where partial upgrades come from, and a
partial upgrade has no symptom: `package.json` claims one version, the override pins
another, npm installs the override, and nothing reports the disagreement.
`packages/api/src/lib/__tests__/version-pins.unit.spec.ts` fails the build when they
disagree, so a partial bump cannot merge.

The script refuses to pin a version that is not published, so a typo fails before it has
rewritten anything.

> Dependabot is deliberately not used. This install needs `npm install --force` to resolve
> at all, and Dependabot's resolver has no equivalent — it would either fail or open pull
> requests that cannot install.

### Diffing against the template

Upstream occasionally changes the starter. To see what moved:

```bash
git remote add upstream https://github.com/mercurjs/mercur.git
git remote set-url --push upstream DISABLED   # fetch-only; nothing here belongs upstream
git fetch upstream

git diff upstream/main:templates/basic/package.json -- package.json
```

Adopt deliberately. Much of what differs is ours on purpose — `deploy/`, CI, the test
suite, `src/subscribers/`, and the production config overlay have no upstream counterpart.

### Why npm, when upstream uses bun

Upstream's template declares `packageManager: bun@1.3.11`. This repository declares
`npm@11.17.0`, because neither bun linker produces the workspace-hoisted `node_modules`
layout Medusa needs. **This is deliberate — do not "fix" it back.**

One visible consequence: `packages/api/.npmrc` holds `public-hoist-pattern` and
`auto-install-peers` settings, which are pnpm/bun options. npm ignores workspace-level
`.npmrc` files entirely and says so on every command:

```
npm warn config ignoring workspace config at .../packages/api/.npmrc
```

That warning is expected and harmless. The file is kept for anyone installing with
pnpm or bun, for whom those hoist patterns are what make Medusa resolvable at all.

### The storefront lives in its own repository

The shopper-facing storefront is **not** in this repository. `@mercurjs/storefront`
requires React 19 while the panels here are pinned to React 18.3.1, so it is deployed as a
separate service from a separate repository. The environment variables that tie the two
together are documented in [`deploy/README.md`](deploy/README.md).

It is also **not tracked against upstream**. Unlike the backend and the panels — which are
published npm packages and upgrade by version bump — `@mercurjs/storefront` is not
published (`private: true` upstream, 404 on npm), so it can only exist as copied source.
It was scaffolded once from `apps/storefront@2.3.4-canary.3` and is owned outright from
that point.

That is a deliberate trade. A storefront is the part of a marketplace you customise most,
and merging upstream's demo design into a customised storefront is worse than not doing
it. The cost is that upstream's storefront fixes do not reach you automatically; its
README lists the known issues carried over, which you now own.

## AI agents

This project bundles its documentation as a dependency (`@mercurjs/docs`), so AI agents can read it offline and version-matched to your installed packages. Point your agent at:

- `node_modules/@mercurjs/docs/llms.txt` — an index of every page
- `node_modules/@mercurjs/docs/content/**/*.mdx` — the full pages

`CLAUDE.md` and `AGENTS.md` instruct agents to read these before making changes. The same docs are online at [docs.mercurjs.com](https://docs.mercurjs.com).

## Questions

If you have any issues or questions start a [GitHub discussion](https://github.com/mercurjs/mercur/discussions).
