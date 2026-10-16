import { fileURLToPath } from 'node:url';
import { defineConfig } from 'astro/config';

// The repo root, resolved here because this file runs unbundled. Code under
// src/ is bundled into chunks whose depth changes between Astro versions, so an
// `import.meta.url`-relative path there points somewhere different after every
// upgrade. src/lib/wiki.ts reads it as __ALMAGEST_REPO_ROOT__.
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

export default defineConfig({
  vite: { define: { __ALMAGEST_REPO_ROOT__: JSON.stringify(REPO_ROOT) } },
  // Set `site` to your published URL for correct canonical links and sitemaps.
  // If deploying to a subpath (e.g. GitHub Pages project sites), also set `base`.
  // site: 'https://example.com',
  // base: '/my-brain',
  outDir: './dist',
  build: { format: 'directory' },
});
