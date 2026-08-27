import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// The SPA talks only to the governed dashboard API. In dev, vite proxies the
// API to a locally running dashboard (default port 7332). In build, assets are
// emitted with relative base so the dashboard server can host them under /app.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: './',
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    proxy: {
      '^/(status|audit|processes|approvals|mission-control|fleet|plugins|marketplace|workspaces|tunnels|tools|policy|chatgpt|logs)(/.*)?$':
        'http://127.0.0.1:7332',
    },
  },
});
