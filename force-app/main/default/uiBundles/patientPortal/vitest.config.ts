import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './vitest.setup.ts',
    // Playwright runs e2e/ against the built site.
    exclude: ['e2e/**', 'node_modules/**', 'dist/**'],
  },
});
