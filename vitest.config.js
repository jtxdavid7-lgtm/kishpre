import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  esbuild: {
    jsx: 'automatic'
  },
  resolve: {
    alias: {
      '@cloudbase/js-sdk': path.resolve('node_modules/@cloudbase/js-sdk/dist/index.esm.js')
    }
  },
  test: {
    environment: 'happy-dom'
  }
});
