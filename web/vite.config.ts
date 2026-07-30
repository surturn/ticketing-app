import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],

  // Mirrors the `@/*` paths mapping in tsconfig.json — both are needed, since
  // TypeScript resolves types and Vite resolves the actual imports.
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },

  server: {
    port: 3000,
    // The API and the storefront share one origin in production, so /api is a
    // same-origin path in the client code. Proxying in development keeps it that
    // way — no base URL to switch, and no CORS to configure locally.
    proxy: {
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
    },
  },

  build: {
    // Emitted where the API serves static files from.
    outDir: 'dist',
    sourcemap: true,
  },
});
