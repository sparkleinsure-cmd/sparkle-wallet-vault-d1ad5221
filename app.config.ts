import { defineConfig } from '@lovable.dev/vite-tanstack-config';

export default defineConfig({
  server: {
    preset: 'github-pages',
    baseURL: '/sparkle-wallet-vault/'
  },
  vite: {
    base: '/sparkle-wallet-vault/',
  }
});
