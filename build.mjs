import * as esbuild from 'esbuild';
import { readFileSync } from 'fs';

const pkg = JSON.parse(readFileSync('./package.json', 'utf8'));

// Get all dependencies to mark as external
const external = [
  ...Object.keys(pkg.dependencies || {}),
  ...Object.keys(pkg.devDependencies || {}),
];

// Shebang banner so the bin entrypoints are directly executable via npx
const shebang = { js: '#!/usr/bin/env node' };

// Build main entry point
await esbuild.build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: 'dist/index.js',
  external,
  banner: shebang,
});

console.log('Build complete!');
