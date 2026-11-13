import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["server/**/*.docker.test.ts"],
    testTimeout: 600_000,
    hookTimeout: 300_000,
    fileParallelism: false,
  },
})
