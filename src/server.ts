/**
 * Server entry point. Port comes from APP_PORT (default 3000).
 */
import { createServer } from 'node:http';
import { handleRequest, readBody } from './app.js';

const port = Number.parseInt(process.env.APP_PORT ?? '3000', 10);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`APP_PORT must be a valid port number, got "${process.env.APP_PORT}"`);
}

const server = createServer((req, res) => {
  const url = req.url ?? '/';
  readBody(req)
    .then(async body => {
      let response;
      try {
        response = await handleRequest(req.method ?? 'GET', url, body);
      } catch (err) {
        response = {
          status: 500,
          body: { error: 'internal_error', message: (err as Error).message },
        };
      }
      const json = JSON.stringify(response.body);
      res.writeHead(response.status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(json),
      });
      res.end(json);
    })
    .catch(err => {
      const status = err.message === 'request body too large' ? 413 : 500;
      const json = JSON.stringify({ error: status === 413 ? 'body_too_large' : 'internal_error' });
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(json);
    });
});

server.listen(port, () => {
  console.log(`pool-allocator listening on port ${port}`);
});

const shutdown = (signal: string) => {
  console.log(`received ${signal}, shutting down`);
  server.close(() => process.exit(0));
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
