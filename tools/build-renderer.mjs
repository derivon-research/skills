#!/usr/bin/env node

import { build } from 'esbuild';
import { chmod, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const scriptsDirectory = new URL('../derivon-mindmap/scripts/', import.meta.url);
await mkdir(scriptsDirectory, { recursive: true });

const renderer = new URL('render-documents.mjs', scriptsDirectory);
await bundle(new URL('./render-documents.source.mjs', import.meta.url), renderer, [{
  name: 'inline-katex-fonts',
  setup(buildContext) {
    buildContext.onLoad({ filter: /katex\.min\.css$/ }, async ({ path: cssPath }) => {
      let css = await readFile(cssPath, 'utf8');
      css = css.replace(/src:(url\([^)]+\.woff2\) format\("woff2"\))(?:,[^}]*)}/g, 'src:$1}');
      const fontUrls = [...css.matchAll(/url\((fonts\/[^)]+)\)/g)].map((match) => match[1]);
      for (const fontUrl of new Set(fontUrls)) {
        const bytes = await readFile(path.resolve(path.dirname(cssPath), fontUrl));
        const mime = fontUrl.endsWith('.woff2') ? 'font/woff2' : 'font/woff';
        css = css.replaceAll(`url(${fontUrl})`, `url(data:${mime};base64,${bytes.toString('base64')})`);
      }
      return { contents: `export default ${JSON.stringify(css)};`, loader: 'js' };
    });
  },
}]);

await bundle(
  new URL('./crosslink-documents.source.mjs', import.meta.url),
  new URL('crosslink-documents.mjs', scriptsDirectory),
);
await bundle(
  new URL('./export-route-textbook.source.mjs', import.meta.url),
  new URL('export-route-textbook.mjs', scriptsDirectory),
);

async function bundle(entry, outfile, plugins = []) {
  await build({
    entryPoints: [entry.pathname],
    outfile: outfile.pathname,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    plugins,
    banner: { js: '#!/usr/bin/env node' },
    legalComments: 'eof',
  });
  await chmod(outfile, 0o755);
  console.log(`Built ${outfile.pathname}`);
}
