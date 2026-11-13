import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  root: "web",
  plugins: [react()],
  optimizeDeps: { exclude: ["@ui-sdk/core"] },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
  },
  server: {
    port: 4610,
    proxy: {
      "/api": { target: "http://127.0.0.1:4600", changeOrigin: true },
    },
  },
})
