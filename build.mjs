/* PERCEPTION - renderer bundle build */
import * as esbuild from 'esbuild';
import fs from 'node:fs';

fs.mkdirSync('dist', { recursive: true });

await esbuild.build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  outfile: 'dist/game.js',
  format: 'iife',
  target: ['chrome120'],
  minify: true,
  sourcemap: false,
  logLevel: 'info',
  legalComments: 'none',
  define: { 'process.env.NODE_ENV': '"production"' }
});

for (const f of ['app/index.html', 'app/style.css']) {
  fs.copyFileSync(f, 'dist/' + f.split('/').pop());
}
console.log('[build] dist ready');
