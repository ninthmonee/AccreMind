import { defineConfig } from 'vite';
const target = `http://${process.env.HOST === '::1' ? '[::1]' : '127.0.0.1'}:${process.env.PORT ?? 3100}`;
export default defineConfig({
  build: {
    rollupOptions: {
      onwarn(warning, warn) {
        // This is a client-only app; React Query's RSC directive is intentionally unused.
        if (
          warning.code === 'MODULE_LEVEL_DIRECTIVE' &&
          warning.id?.includes('@tanstack/react-query')
        )
          return;
        warn(warning);
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': target,
      '/healthz': target,
      '/readyz': target,
    },
  },
});
