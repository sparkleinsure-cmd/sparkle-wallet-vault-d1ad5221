import { defineConfig } from '@lovable.dev/vite-tanstack-config';

export default defineConfig({
  server: {
    preset: 'static',
  },
  vite: {
    base: './',
  }
});
