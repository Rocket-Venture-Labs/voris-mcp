import { defineConfig } from "vitest/config"

// STAGED public-repo vitest config (ADR-093). Synced to the public bridge repo as
// vitest.config.ts. The public repo's ONLY tests are the publish-time gate: the
// layout-agnostic init->lists smoke (T60) and the reproducible-build check (T61).
// Both are slow (build + pack + install), but in the public repo they ARE the test
// suite — run by release.yml before publish — so there's no fast/slow split to make.
export default defineConfig({
  test: {
    include: ["src/__tests__/**/*.test.ts"],
  },
})
