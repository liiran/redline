import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

const DEV_PORT = 4610
const SERVER = "http://127.0.0.1:4600"

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
    port: DEV_PORT,
    proxy: {
      "/api": {
        target: SERVER,
        changeOrigin: true,
        // The server only takes changes from its own page. In development that page is Vite's, so
        // its origin is swapped for the server's. Any other site keeps its own and is still refused.
        configure: (proxy) =>
          proxy.on("proxyReq", (req) => {
            const origin = req.getHeader("origin")
            if (origin === `http://localhost:${DEV_PORT}` || origin === `http://127.0.0.1:${DEV_PORT}`) req.setHeader("origin", SERVER)
          }),
      },
    },
  },
})
