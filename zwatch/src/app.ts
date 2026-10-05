import express from 'express';
import type { ErrorRequestHandler } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { accountInput, WatcherError } from '@ghostpass/watcher-contract';
import type { WatcherBackend } from './backend.ts';

export function createWatcherApp(backend: WatcherBackend, token: string) {
  if (token.length < 16) throw new Error('watcher_api_token_required');
  const app = express();
  app.disable('x-powered-by');
  // This service is server-to-server only. Reject browser origins and non-loopback Host headers.
  app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (req.headers.origin || !/^(127\.0\.0\.1|localhost|\[::1\])(:[0-9]+)?$/.test(req.headers.host ?? '')) {
      return res.status(403).json({ error: 'loopback_clients_only' });
    }
    if (req.path === '/health' && req.method === 'GET') return next();
    const provided = Buffer.from(req.get('Authorization') ?? '');
    const expected = Buffer.from(`Bearer ${token}`);
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    next();
  });
  app.use(express.json({ limit: '16kb', strict: true }));
  app.get('/health', async (_req, res) => {
    const h = await backend.health();
    res.status(h.ready ? 200 : 503).json({ ...h, v: 1, mode: backend.mode });
  });
  app.post('/accounts', async (req, res) => {
    const accountId = await backend.importAccount(accountInput(req.body));
    res.status(201).json({ accountId });
  });
  app.get('/accounts/:id/received', async (req, res) => {
    const query = req.query.sinceHeight;
    if (query !== undefined && (typeof query !== 'string' || !/^(0|[1-9][0-9]{0,9})$/.test(query) || Number(query) > 0xffff_ffff)) {
      throw new WatcherError('invalid_since_height');
    }
    res.json(await backend.received(req.params.id!, Number(query ?? 0)));
  });
  app.get('/accounts/:id/balance', async (req, res) => {
    res.json(await backend.balance(req.params.id!));
  });
  app.use((_req, res) => { res.status(404).json({ error: 'not_found' }); });
  const errors: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    if (error instanceof WatcherError) { res.status(error.status).json({ error: error.code }); return; }
    const e = error as { type?: string };
    if (e.type === 'entity.parse.failed') { res.status(400).json({ error: 'invalid_json' }); return; }
    if (e.type === 'entity.too.large') { res.status(413).json({ error: 'body_too_large' }); return; }
    // Never echo subprocess arguments, viewing keys, memos, or wallet paths to clients/logs.
    res.status(503).json({ error: 'watcher_unavailable' });
  };
  app.use(errors);
  return app;
}
