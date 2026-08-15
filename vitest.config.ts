import { defineConfig } from 'vitest/config'

// Keep the suite scoped to this repository's tests: the .harness-build
// checkout used by `scripts/build.ts --frozen` lives inside the tree and
// would otherwise be swept in by vitest's default include glob.
export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
  },
})
