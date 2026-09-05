import fs from "fs"
import path from "path"

/**
 * The pinned versions have to agree across every place they are written down.
 *
 * `@medusajs/*` and `zod` are pinned in three places: each workspace's own
 * dependencies, the root `overrides` (npm), and the root `resolutions` (pnpm/yarn).
 * They are duplicated so that consumers on any package manager resolve the same tree.
 *
 * That duplication is the hazard. An upgrade that bumps a dependency but not the
 * override has NO SYMPTOM: package.json claims 2.19.0, the override still pins 2.18.0,
 * npm installs 2.18.0, and nothing anywhere reports the disagreement. The build is green
 * and the running code is not the version the manifest advertises.
 *
 * Hand-editing 27 entries is exactly where that comes from, which is why
 * `npm run upgrade:mercur -- <version>` exists. This test is what stops a partial edit
 * from merging.
 */

const repoRoot = path.resolve(__dirname, "../../../../..")

const readJson = (relative: string) =>
  JSON.parse(fs.readFileSync(path.join(repoRoot, relative), "utf8"))

const root = readJson("package.json")

const pinned = (deps: Record<string, string> = {}) =>
  Object.fromEntries(
    Object.entries(deps).filter(([name]) => name.startsWith("@medusajs/") || name === "zod")
  )

describe("version pins", () => {
  it("declares overrides and resolutions identically", () => {
    // npm reads `overrides`, pnpm and yarn read `resolutions`. If they drift, the tree
    // depends on which package manager ran — the exact ambiguity pinning exists to remove.
    expect(root.overrides).toEqual(root.resolutions)
  })

  it.each([
    ["package.json"],
    ["packages/api/package.json"],
    ["apps/admin/package.json"],
    ["apps/vendor/package.json"],
  ])("pins %s to the same versions as the root overrides", (manifest) => {
    const pkg = readJson(manifest)
    const declared = {
      ...pinned(pkg.dependencies),
      ...pinned(pkg.devDependencies),
    }

    for (const [name, version] of Object.entries(declared)) {
      // An override that does not exist is its own bug: the dependency is unpinned and
      // free to float, which is what the overrides block exists to prevent.
      expect({ [name]: root.overrides[name] }).toEqual({ [name]: version })
    }
  })

  it("pins every version exactly, with no ranges", () => {
    // A caret in an override defeats the point — it re-introduces the float. This is how
    // @medusajs/ui reached 4.2.3 in the storefront while upstream tests 4.1.19.
    for (const [name, version] of Object.entries(root.overrides as Record<string, string>)) {
      expect({ [name]: version }).toEqual({ [name]: version.replace(/^[\^~>=<\s]+/, "") })
    }
  })
})
