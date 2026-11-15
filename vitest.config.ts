import { defineConfig } from 'vitest/config';

// Engine tests run in plain Node: the engine must never touch the DOM.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts'],
  },
});
