import { Router } from 'express';
import { fetched } from '../../core/response';
import { release, shopNotes } from './release';

export const releaseRouter = Router();

// Public, like /health: the shop app shows "What's new" and spots a stale build before sign-in too.
releaseRouter.get('/', (_req, res) => {
  const r = release();
  fetched(res, { version: r.version, deployedAt: r.deployedAt, notes: shopNotes() });
});
