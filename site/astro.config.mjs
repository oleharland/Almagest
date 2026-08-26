import { defineConfig } from 'astro/config';

export default defineConfig({
  // Set `site` to your published URL for correct canonical links and sitemaps.
  // If deploying to a subpath (e.g. GitHub Pages project sites), also set `base`.
  // site: 'https://example.com',
  // base: '/my-brain',
  outDir: './dist',
  build: { format: 'directory' },
});
