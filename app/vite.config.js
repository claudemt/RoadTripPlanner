import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {defineConfig} from 'vite';

const appRoot = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.join(appRoot, 'web');
const outputRoot = path.join(appRoot, 'dist');
const sceneRoot = path.resolve(appRoot, '..', 'data', 'scenes');

function copySharedScenes() {
  return {
    name: 'copy-shared-scenes',
    configureServer(server) {
      server.middlewares.use('/scene/', (request, response, next) => {
        const pathname = decodeURIComponent(String(request.url || '').split('?')[0])
          .replace(/^\/scene\//, '')
          .replace(/^\/+/, '');
        const target = path.resolve(sceneRoot, pathname);
        const scenePrefix = `${sceneRoot}${path.sep}`;
        if (!target.startsWith(scenePrefix) || !fs.existsSync(target) || fs.statSync(target).isDirectory()) {
          next();
          return;
        }
        const extension = path.extname(target).toLowerCase();
        const contentType = extension === '.js'
          ? 'text/javascript;charset=utf-8'
          : extension === '.png'
            ? 'image/png'
            : extension === '.jpg' || extension === '.jpeg'
              ? 'image/jpeg'
              : 'application/octet-stream';
        response.setHeader('Content-Type', contentType);
        response.setHeader('Cache-Control', 'no-store');
        fs.createReadStream(target).pipe(response);
      });
    },
    closeBundle() {
      if (!fs.existsSync(sceneRoot)) return;
      fs.cpSync(sceneRoot, path.join(outputRoot, 'scene'), {
        recursive: true,
        force: true,
      });
    },
  };
}

export default defineConfig({
  root: webRoot,
  envDir: appRoot,
  publicDir: false,
  base: '/',
  plugins: [copySharedScenes()],
  build: {
    outDir: outputRoot,
    emptyOutDir: true,
    sourcemap: false,
  },
  preview: {
    port: 4173,
  },
});
