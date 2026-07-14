/**
 * Reproducible-build check for @voris/mcp (spec A042 T61 / AC13, publish-time CI gate).
 *
 * WHERE THIS RUNS: the dedicated PUBLIC bridge repo ONLY (ADR-093). Staged here at
 * packages/mcp/publish/reproducible-build.test.ts and copied to src/__tests__/reproducible-build.test.ts
 * by scripts/sync-public.sh; the public release.yml runs it via `npm run check:reproducible`
 * BEFORE `npm publish --provenance`. It is INERT in the monorepo — the monorepo vitest include
 * is src/__tests__/** and this file lives under publish/, so `pnpm test` never picks it up. The
 * exhaustive packaging + wire-protocol gate is the monorepo T59 tarball smoke; this file is the
 * deterministic publish-time subset (ADR-093 §4).
 *
 * WHAT IT PROVES — that the artifact a consumer verifies against npm provenance is reproducible
 * from the committed source:
 *   1. DETERMINISM: two clean `tsc` builds from source produce a byte-identical dist/. Both builds
 *      run in the SAME dist/ location on purpose — source-map `sources` are relative, so an
 *      identical layout isolates the comparison to the compiler, which is the reproducibility claim.
 *   2. FIDELITY: the published tarball's dist/ is byte-identical to that fresh build — `npm pack`
 *      ships exactly the built output, nothing stale or hand-edited.
 *   3. HYGIENE (T59 carry): the tarball ships EXACTLY the 11 expected files — the 8 dist artifacts
 *      + LICENSE + README + package.json — with NO test files and NO `.ts` sources. This is the
 *      backing test for the tsconfig.build.json `exclude: ["src/__tests__"]` boundary, which was
 *      previously the ONLY thing keeping tests out of the published artifact.
 *
 * NOT COVERED HERE (documented, out of CI scope by design): the one-call-per-tool round-trip against
 * the REAL catalog needs the live mcp.voris.ai endpoint + a valid VORIS_API_KEY (a non-deterministic
 * external dependency) → LAUNCH VALIDATION, not a CI gate. The CI slice is build determinism +
 * tarball fidelity (this file) + the init→lists smoke (publish/smoke.test.ts) + npm provenance.
 */
import { describe, it, expect, beforeAll } from "vitest"
import { execSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

// Standalone public-repo root: src/__tests__ -> src -> root (two up), matching smoke.test.ts.
const REPO_ROOT = resolve(import.meta.dirname, "..", "..")
const DIST = join(REPO_ROOT, "dist")

// The committed source is exactly bin.ts + bridge.ts (sync-public.sh copies only these two), and
// declaration + declarationMap + sourceMap are all on (tsconfig), so each source emits 4 artifacts.
const EXPECTED_DIST = [
  "bin.d.ts", "bin.d.ts.map", "bin.js", "bin.js.map",
  "bridge.d.ts", "bridge.d.ts.map", "bridge.js", "bridge.js.map",
].sort()

// package.json `files: ["dist","LICENSE","README.md"]` + the always-included package.json = 11.
const EXPECTED_TARBALL = [
  "package/package.json", "package/LICENSE", "package/README.md",
  ...EXPECTED_DIST.map((f) => `package/dist/${f}`),
].sort()

/** sha256 of every file under `dir`, keyed by its POSIX-relative path. */
function hashTree(dir: string, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {}
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name
    const abs = join(dir, e.name)
    if (e.isDirectory()) Object.assign(out, hashTree(abs, rel))
    else out[rel] = createHash("sha256").update(readFileSync(abs)).digest("hex")
  }
  return out
}

/** Clean `tsc` build from source; returns the dist file→hash map. */
function cleanBuild(): Record<string, string> {
  rmSync(DIST, { recursive: true, force: true })
  execSync("npm run build", { cwd: REPO_ROOT, stdio: "pipe" })
  return hashTree(DIST)
}

describe("@voris/mcp reproducible build (spec A042 T61)", () => {
  let buildA: Record<string, string>
  let buildB: Record<string, string>
  let packedDist: Record<string, string>
  let packedFiles: string[]

  beforeAll(() => {
    buildA = cleanBuild()
    buildB = cleanBuild() // dist/ now holds buildB — the tree `npm pack` tars below

    const packDest = mkdtempSync(join(tmpdir(), "voris-mcp-repro-pack-"))
    const packOut = execSync(`npm pack --pack-destination "${packDest}" --loglevel=error`, {
      cwd: REPO_ROOT,
      encoding: "utf-8",
    })
    const tgz = packOut.trim().split("\n").map((l) => l.trim()).findLast((l) => l.endsWith(".tgz"))
    if (!tgz) throw new Error(`npm pack produced no tarball:\n${packOut}`)
    const tarball = tgz.startsWith("/") ? tgz : join(packDest, tgz)

    const extract = mkdtempSync(join(tmpdir(), "voris-mcp-repro-extract-"))
    execSync(`tar -xzf "${tarball}" -C "${extract}"`, { stdio: "pipe" })
    const tree = hashTree(extract) // npm tarballs nest everything under a top-level package/ dir
    packedFiles = Object.keys(tree).sort()
    packedDist = Object.fromEntries(
      Object.entries(tree)
        .filter(([p]) => p.startsWith("package/dist/"))
        .map(([p, h]) => [p.slice("package/dist/".length), h] as const),
    )
  }, 180_000)

  it("two clean tsc builds from source are byte-identical (deterministic → reproducible)", () => {
    expect(Object.keys(buildA).sort()).toEqual(EXPECTED_DIST) // dist = bin+bridge × {js,js.map,d.ts,d.ts.map}
    expect(buildB).toEqual(buildA)
  })

  it("the published tarball's dist is byte-identical to the fresh build (npm pack ships the built output)", () => {
    expect(packedDist).toEqual(buildB)
  })

  it("the tarball ships exactly the expected files — dist + LICENSE + README + package.json, no test/source leak", () => {
    // spec A042 T59 carry: backs the tsconfig.build.json `exclude: ["src/__tests__"]` boundary —
    // the only barrier keeping *.test.ts and raw src/ out of the published, provenance-signed artifact.
    expect(packedFiles).toEqual(EXPECTED_TARBALL)
    expect(packedFiles.some((f) => f.includes("__tests__"))).toBe(false)
    expect(packedFiles.some((f) => /\.test\.[cm]?[jt]s$/.test(f))).toBe(false)
    expect(packedFiles.some((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"))).toBe(false)
  })
})
