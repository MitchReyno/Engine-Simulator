import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  worker: { format: 'es' },
  server: { port: 5183, strictPort: false },
  test: { include: ['tests/**/*.test.ts'], testTimeout: 120000 },
} as any);
