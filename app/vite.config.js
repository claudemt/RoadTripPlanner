import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {defineConfig} from 'vite';

const appRoot = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.join(appRoot, 'web');
const outputRoot = path.join(appRoot, 'dist');

export default defineConfig({
  root: webRoot,
  envDir: appRoot,
  publicDir: false,
  base: '/',
  build: {
    outDir: outputRoot,
    emptyOutDir: true,
    sourcemap: false,
  },
  preview: {
    port: 4173,
  },
});
