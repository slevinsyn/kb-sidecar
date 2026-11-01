import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vite';
import type { Plugin } from 'vite';

function graphJsonPath(): string {
  const home = process.env.KB_HOME;
  const base = home && home.length > 0 ? home : join(homedir(), 'claude-kb');
  return join(base, 'graph', 'graph.json');
}

function serveGraphJson(): Plugin {
  return {
    name: 'serve-graph-json',
    configureServer(server) {
      server.middlewares.use('/graph.json', (req, res, next) => {
        if (req.method !== 'GET') {
          next();
          return;
        }
        readFile(graphJsonPath(), 'utf8').then(
          (text) => {
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.setHeader('Cache-Control', 'no-store');
            res.end(text);
          },
          (err: NodeJS.ErrnoException) => {
            const notFound = err.code === 'ENOENT';
            console.error(`Cannot read ${graphJsonPath()}: ${err.message}`);
            res.statusCode = notFound ? 404 : 500;
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.end(notFound ? 'graph.json not found' : 'could not read graph.json');
          },
        );
      });
    },
  };
}

export default defineConfig({
  plugins: [serveGraphJson()],
});
