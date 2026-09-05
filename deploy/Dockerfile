# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Mercur marketplace backend (Medusa 2 + @mercurjs/core)
#
# The image contains the `medusa build` artifact (packages/api/.medusa/server)
# with the admin panel (/dashboard) and vendor panel (/seller) bundled into it,
# so a single container serves the API and both dashboards.
#
# IMPORTANT: the panels bake their backend origin at BUILD time. You must pass
#   --build-arg MERCUR_BACKEND_URL=https://your-public-origin
# or the panels will call http://localhost:9000 from the browser and fail.
#
# Build context is the REPOSITORY ROOT, not deploy/:
#   docker build -f deploy/Dockerfile --build-arg MERCUR_BACKEND_URL=... .
#
# The image builds the checked-in sources unmodified. There is no config swap: the
# deployment settings live in packages/api/src/lib/production-overlay.ts, which
# medusa-config.ts delegates to and which is a no-op unless the relevant variables
# are set. docker-compose.yml always sets them.
#
# This used to copy deploy/medusa-config.production.ts over packages/api/medusa-config.ts.
# That file was a duplicate of the upstream config, and duplicates rot: when upstream
# changed medusa-config.ts the copy silently kept the old version.
# ---------------------------------------------------------------------------

# ---------- Stage 1: build ----------
FROM node:22-bookworm-slim AS builder

ARG MERCUR_BACKEND_URL

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates python3 make g++ git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install with NODE_ENV unset: the build needs devDependencies (vite, typescript,
# and the @acme/admin + @acme/vendor workspaces that packages/api pulls in via `^build`).
# `package-lock.jso[n]` is an optional-source glob: it picks a committed lockfile
# up when there is one and is skipped when there isn't, without breaking the COPY.
# Commit a lockfile to make these builds reproducible.
COPY package.json turbo.json tsconfig.base.json tsconfig.json blocks.json .npmrc package-lock.jso[n] ./
COPY apps/admin/package.json ./apps/admin/
COPY apps/vendor/package.json ./apps/vendor/
COPY packages/api/package.json ./packages/api/
# npm, not bun, and deliberately so. The project's own .yarnrc.yml states the
# requirement: "Medusa is not compatible with Plug'n'Play, and hosts that build the
# monorepo expect node_modules with workspace-scoped hoisting." Neither bun linker
# delivers that here:
#   - isolated (Bun 1.3's default for workspaces) buries each package's deps in
#     node_modules/.bun/<pkg>@<ver>/, and Rollup then cannot resolve the panels'
#     transitive imports (e.g. i18next, a real dependency of @mercurjs/admin).
#   - --linker hoisted flattens too aggressively and does not nest a conflicting
#     version, so ajv-draft-04 resolves the root ajv@6 and `medusa build` dies on
#     "Cannot find module 'ajv/dist/core'".
# npm nests conflicting versions correctly and honours the `overrides` block that
# package.json already uses to pin the @medusajs/* versions.
#
# --force, and specifically NOT --legacy-peer-deps. The root package.json pins
# react-hook-form@7.49.1 while also pinning @hookform/resolvers@5.4.0, which
# peer-requires react-hook-form@^7.55.0, so a strict install fails with ERESOLVE.
# The two flags are not interchangeable:
#   --force              installs peers, but tolerates a conflicting range. This
#                        reproduces exactly what bun resolves (it reports the same
#                        react-hook-form mismatch as a warning and proceeds).
#   --legacy-peer-deps   skips peer installation entirely. ajv-draft-04 declares
#                        `ajv` as a peer (^8), so it then resolves the hoisted
#                        ajv@6 and everything that loads medusa-config.ts dies on
#                        "Cannot find module 'ajv/dist/core'" — first the
#                        dashboard-sdk Vite plugin, which silently falls back to
#                        building the panels with base "/", then `medusa build`.
RUN npm install --force --no-audit --no-fund

COPY . .

# The panels import route types from `@acme/api/_generated`, which packages/api only
# exposes once codegen has written .mercur/routes.d.ts. Turborepo builds the panels
# BEFORE packages/api (packages/api depends on them via `^build`), so codegen cannot
# live in the build graph — it has to run first. This is the same step Medusa Cloud
# runs as `cloud:prebuild`.
RUN npm run codegen --workspace @acme/api

# NODE_ENV=production here makes scripts/bundle-dashboards.mjs fail fast on a
# missing panel build, a wrong asset base path, or a missing MERCUR_BACKEND_URL,
# instead of shipping a panel that points at localhost.
ENV NODE_ENV=production \
    MERCUR_BACKEND_URL=${MERCUR_BACKEND_URL} \
    VITE_MERCUR_BACKEND_URL=${MERCUR_BACKEND_URL}
RUN npm run build

# Install the artifact's runtime dependencies. `medusa build` copies packages/api's
# package.json into the artifact; bundle-dashboards.mjs has already stripped the
# workspace-protocol entries that cannot be resolved from a registry.
WORKDIR /app/packages/api/.medusa/server

# Reconcile the artifact manifest with a standalone install: drop the panel
# workspaces from devDependencies and carry the monorepo root's `overrides` in.
# See deploy/prepare-artifact.mjs for why both are required.
RUN node /app/deploy/prepare-artifact.mjs /app/package.json ./package.json \
    && npm install --omit=dev --no-audit --no-fund

# ---------- Stage 2: runtime ----------
FROM node:22-bookworm-slim AS runner

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=9000

WORKDIR /app

COPY --from=builder --chown=node:node /app/packages/api/.medusa/server ./
COPY --chown=node:node deploy/entrypoint.sh /usr/local/bin/entrypoint.sh

# `static/` is where the local file provider writes uploads; mount a volume here
# (or switch to S3) so uploads survive a redeploy.
RUN chmod +x /usr/local/bin/entrypoint.sh \
    && mkdir -p /app/static \
    && chown -R node:node /app/static

USER node

EXPOSE 9000

# start-period covers first-boot migrations, which take minutes on an empty
# database. Failures inside it do not count, and the worker gates on this
# healthcheck, so too short a window would block the worker rather than the
# other way round.
HEALTHCHECK --interval=15s --timeout=5s --start-period=600s --retries=5 \
    CMD curl -fsS http://127.0.0.1:${PORT}/health || exit 1

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["server"]
