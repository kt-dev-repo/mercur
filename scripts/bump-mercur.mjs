#!/usr/bin/env node
/**
 * Bump the pinned Mercur and Medusa versions, everywhere they are written down.
 *
 *   npm run upgrade:mercur -- --mercur 2.3.4
 *   npm run upgrade:mercur -- --mercur 2.3.4 --medusa 2.19.0
 *
 * The versions live in three places that must move together: each workspace's own
 * dependencies, the root `overrides` (npm), and the root `resolutions` (pnpm/yarn).
 * Editing 27 entries by hand is where partial upgrades come from, and a partial upgrade
 * has no symptom — npm resolves the override and the manifest quietly lies about what is
 * installed. `version-pins.unit.spec.ts` fails the build when that happens; this script
 * is how you avoid causing it.
 *
 * Upgrading is a version bump, never a merge: this repository consumes @mercurjs/* from
 * npm and shares no history with upstream. See "Relationship to upstream Mercur" in
 * README.md.
 */
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

const MANIFESTS = [
  "package.json",
  "packages/api/package.json",
  "apps/admin/package.json",
  "apps/vendor/package.json",
]

const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? undefined : args[i + 1]
}

const mercur = flag("mercur")
const medusa = flag("medusa")

if (!mercur && !medusa) {
  console.error(
    "Nothing to do.\n\n" +
      "  npm run upgrade:mercur -- --mercur 2.3.4\n" +
      "  npm run upgrade:mercur -- --mercur 2.3.4 --medusa 2.19.0\n"
  )
  process.exit(1)
}

// Check the version exists before rewriting anything. A typo would otherwise produce a
// manifest that only fails at install time, after the edit has been made everywhere.
const assertPublished = (pkg, version) => {
  try {
    execFileSync("npm", ["view", `${pkg}@${version}`, "version"], { stdio: "pipe" })
  } catch {
    console.error(`${pkg}@${version} is not published. Refusing to pin a version that does not exist.`)
    process.exit(1)
  }
}

if (mercur) assertPublished("@mercurjs/core", mercur)
if (medusa) assertPublished("@medusajs/medusa", medusa)

const targetFor = (name) => {
  if (mercur && name.startsWith("@mercurjs/")) return mercur
  if (medusa && name.startsWith("@medusajs/")) return medusa
  return undefined
}

let changes = 0
const rewriteSection = (section, label, file) => {
  if (!section) return
  for (const name of Object.keys(section)) {
    const target = targetFor(name)
    if (target && section[name] !== target) {
      console.log(`  ${file} ${label}: ${name} ${section[name]} -> ${target}`)
      section[name] = target
      changes++
    }
  }
}

for (const manifest of MANIFESTS) {
  const file = path.join(repoRoot, manifest)
  if (!fs.existsSync(file)) continue

  const pkg = JSON.parse(fs.readFileSync(file, "utf8"))
  rewriteSection(pkg.dependencies, "dependencies", manifest)
  rewriteSection(pkg.devDependencies, "devDependencies", manifest)
  rewriteSection(pkg.overrides, "overrides", manifest)
  rewriteSection(pkg.resolutions, "resolutions", manifest)

  fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n")
}

if (!changes) {
  console.log("Already at those versions. Nothing changed.")
  process.exit(0)
}

console.log(
  `\n${changes} pin(s) updated. The lockfile is NOT updated — finish with:\n\n` +
    "  npm install --force\n" +
    "  npm run codegen\n" +
    "  npm run check-types && npm run lint\n" +
    "  npm run test:unit --workspace @acme/api\n" +
    "  npm run test:integration:http --workspace @acme/api   # from a flat clone\n"
)
