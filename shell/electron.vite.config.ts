import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

/**
 * Three renderer pages (chat, toolbar, ghost overlay) and three tiny preloads,
 * one per page, so each renderer only gets the IPC surface it needs (spec 7.3).
 *
 * Preloads are fully bundled: sandboxed preloads cannot require other files.
 * @cline/sdk is ESM-only; it stays external and is loaded with a native
 * dynamic import() from the CJS main bundle (see src/agent/clinePlanner.ts).
 */
export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') },
        external: ['electron', '@cline/sdk'],
      },
    },
  },
  preload: {
    build: {
      externalizeDeps: false,
      rollupOptions: {
        input: {
          chat: resolve(__dirname, 'src/preload/chat.ts'),
          toolbar: resolve(__dirname, 'src/preload/toolbar.ts'),
          ghost: resolve(__dirname, 'src/preload/ghost.ts'),
        },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()],
    build: {
      rollupOptions: {
        input: {
          chat: resolve(__dirname, 'src/renderer/chat/index.html'),
          toolbar: resolve(__dirname, 'src/renderer/toolbar/index.html'),
          ghost: resolve(__dirname, 'src/renderer/ghost/index.html'),
        },
      },
    },
  },
});
