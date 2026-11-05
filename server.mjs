import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from './server/create-server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, 'dist');
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 4173);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '.local-data');
const SECURE_COOKIE = process.env.SECURE_COOKIE === '1';
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN || undefined;
const SETUP_TOKEN = process.env.SETUP_TOKEN || undefined;

export { createServer };

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const { server, shutdownServices, closeStore } = createServer({
    host: HOST,
    port: PORT,
    dataDir: DATA_DIR,
    distDir: DIST,
    secureCookie: SECURE_COOKIE,
    publicOrigin: PUBLIC_ORIGIN,
    setupToken: SETUP_TOKEN,
  });

  let shuttingDown = false;
  async function gracefulShutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Shutting down (${signal})…`);
    shutdownServices();
    await new Promise((resolve) => server.close(() => resolve()));
    await closeStore();
    process.exit(0);
  }

  process.on('SIGTERM', () => {
    gracefulShutdown('SIGTERM').catch((e) => {
      console.error(e);
      process.exit(1);
    });
  });
  process.on('SIGINT', () => {
    gracefulShutdown('SIGINT').catch((e) => {
      console.error(e);
      process.exit(1);
    });
  });

  server.listen(PORT, HOST, () => {
    console.log(`Bài Nhà (local dev): http://${HOST}:${PORT}/`);
    console.log(`Data: ${DATA_DIR}`);
  });
}
