import { defineConfig } from 'vite';

export default defineConfig({
  build: { target: 'es2022' },
  worker: { format: 'es' },
  test: {
    include: ['tests/unit/**/*.test.ts'],
  },
});
