import { defineConfig } from '@lovable.dev/vite-tanstack-config';

export default defineConfig({
  server: {
    preset: 'static', // Forces TanStack to output raw static HTML files instead of server files
  },
  vite: {
    base: '/sparkle-wallet-vault/',
  }
});
