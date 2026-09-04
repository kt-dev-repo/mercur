# Mercur Basic Template

This template comes configured with the bare minimum to get started building your marketplace with Mercur.

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
bun install
bun run codegen
bun dev
```

   `bun run codegen` is required once after a fresh install. It writes
   `packages/api/.mercur/routes.d.ts`, which both panels import as
   `@acme/api/_generated`; without it `bun run build` fails with
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
bunx @mercurjs/cli add block-name
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
bun run codegen   # once after install, or after changing a route
bun run build
```

To type-check every workspace without building:

```bash
bun run check-types
```

## AI agents

This project bundles its documentation as a dependency (`@mercurjs/docs`), so AI agents can read it offline and version-matched to your installed packages. Point your agent at:

- `node_modules/@mercurjs/docs/llms.txt` — an index of every page
- `node_modules/@mercurjs/docs/content/**/*.mdx` — the full pages

`CLAUDE.md` and `AGENTS.md` instruct agents to read these before making changes. The same docs are online at [docs.mercurjs.com](https://docs.mercurjs.com).

## Questions

If you have any issues or questions start a [GitHub discussion](https://github.com/mercurjs/mercur/discussions).
