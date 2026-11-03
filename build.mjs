import { build } from 'esbuild';

await build({
  entryPoints: ['src/main.tsx'],
  bundle: true,
  outfile: 'public/assets/app.js',
  platform: 'browser',
  format: 'iife',
  target: ['es2020'],
  minify: true,
  sourcemap: false,
  jsx: 'automatic',
  jsxImportSource: 'react',
});
console.log('Built public/assets/app.js');
