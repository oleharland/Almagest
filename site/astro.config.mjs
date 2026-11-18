import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'astro/config';
import { WIKI_DIRS } from '../tools/lib/wiki-core.mjs';

// The repo root, resolved here because this file runs unbundled. Code under
// src/ is bundled into chunks whose depth changes between Astro versions, so an
// `import.meta.url`-relative path there points somewhere different after every
// upgrade. src/lib/wiki.ts reads it as __ALMAGEST_REPO_ROOT__.
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * The wiki lives outside the site's root, so the dev server does not watch it.
 * Watch it, and when a page is added, removed or changed:
 *
 *   1. tell Astro to forget its cached getStaticPaths() result, or a new page
 *      is listed on the index and answers 404. `astro:content-changed` is the
 *      event Astro's own content collections send for this; it is not a
 *      documented API, so check it when upgrading Astro.
 *   2. reload the open tab.
 *
 * Reading the fresh content is src/lib/wiki.ts's job: it re-reads when a file's
 * size or mtime moves.
 */
function reloadOnWikiChange() {
  const dirs = WIKI_DIRS.map((brain) => path.resolve(REPO_ROOT, brain.dir));
  return {
    name: 'almagest:reload-on-wiki-change',
    apply: 'serve',
    configureServer(server) {
      server.watcher.add(dirs);
      const onChange = (file) => {
        if (!file.endsWith('.md') || !dirs.some((dir) => file.startsWith(dir + path.sep))) return;
        for (const name of ['ssr', 'prerender']) {
          server.environments?.[name]?.hot?.send('astro:content-changed', {});
        }
        server.ws.send({ type: 'full-reload' });
      };
      for (const event of ['add', 'change', 'unlink']) server.watcher.on(event, onChange);
    },
  };
}

export default defineConfig({
  vite: {
    define: { __ALMAGEST_REPO_ROOT__: JSON.stringify(REPO_ROOT) },
    plugins: [reloadOnWikiChange()],
  },
  // Set `site` to your published URL for correct canonical links and sitemaps.
  // If deploying to a subpath (e.g. GitHub Pages project sites), also set `base`.
  // site: 'https://example.com',
  // base: '/my-brain',
  outDir: './dist',
  build: { format: 'directory' },
});
