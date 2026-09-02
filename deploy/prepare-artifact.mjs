#!/usr/bin/env node
/**
 * Prepares `medusa build`'s artifact manifest (.medusa/server/package.json) for a
 * standalone production install. Run from inside the artifact directory, before
 * `npm install --omit=dev`.
 *
 * `medusa build` copies packages/api's package.json into the artifact verbatim, which
 * leaves two problems for an install outside the monorepo:
 *
 *  1. devDependencies still list the panel workspaces (@acme/admin, @acme/vendor).
 *     bundle-dashboards.mjs strips only `workspace:`-prefixed entries and these are
 *     pinned as "*", so npm tries to resolve them against the public registry and 404s
 *     — npm builds the full dependency tree even under --omit=dev. Nothing in
 *     devDependencies is needed to run the server; the panels are already bundled in
 *     as static files.
 *
 *  2. The `overrides` block lives in the monorepo ROOT package.json, not in
 *     packages/api's, so the artifact resolves without it. @mercurjs/core peer-requires
 *     @medusajs/test-utils@">=2.18.0", which floats to 2.19.0 and drags in a
 *     peer @medusajs/framework@2.19.0 that conflicts with the pinned 2.18.0 → ERESOLVE.
 *     Copying the root overrides in reproduces the monorepo's own resolution.
 *
 * Usage: node prepare-artifact.mjs <root-package.json> <artifact-package.json>
 */
import fs from 'node:fs'

const [rootManifestPath, artifactManifestPath] = process.argv.slice(2)

if (!rootManifestPath || !artifactManifestPath) {
  console.error('usage: prepare-artifact.mjs <root-package.json> <artifact-package.json>')
  process.exit(1)
}

const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'))

const root = read(rootManifestPath)
const artifact = read(artifactManifestPath)

const removed = Object.keys(artifact.devDependencies ?? {})
delete artifact.devDependencies

// The artifact's own overrides win over the root's, should it ever declare any.
const rootOverrides = root.overrides ?? {}
artifact.overrides = { ...rootOverrides, ...(artifact.overrides ?? {}) }

fs.writeFileSync(artifactManifestPath, JSON.stringify(artifact, null, 2) + '\n')

console.log(
  `[prepare-artifact] dropped ${removed.length} devDependencies` +
    (removed.length ? ` (${removed.join(', ')})` : '') +
    `; carried over ${Object.keys(rootOverrides).length} root overrides.`
)
