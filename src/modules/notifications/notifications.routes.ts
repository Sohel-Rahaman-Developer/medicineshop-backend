import { Router, type Request, type Response } from 'express';
import { asyncHandler } from '../../core/async-handler';
import { actorOf } from '../user/actor';
import { AppError } from '../../core/errors';
import { requirePermission, shopAuth, tenantOf } from '../../core/middleware/tenant';
import { validate } from '../../core/middleware/validate';
import { fetched, sent } from '../../core/response';
import * as svc from './notifications.service';
import { alertSettingsSchema, listSchema, prefsSchema, readSchema, snoozeSchema, type AlertSettingsInput, type PrefsInput } from './notifications.validation';

const userOf = (req: Request) => {
  if (!req.auth) throw AppError.unauthenticated();
  return req.auth.userId;
};

// PLAN §17 / S72: everyone reads their own alerts (notifications:view); read, snooze and preferences are per person.
export const notificationsRouter = Router();
notificationsRouter.use(shopAuth, requirePermission('notifications', 'view'));

notificationsRouter.get(
  '/',
  validate({ query: listSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    fetched(res, await svc.list(tenantOf(req), userOf(req), { all: (req.query as { all?: string }).all === '1' }));
  }),
);

notificationsRouter.post(
  '/read',
  validate({ body: readSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const body = req.body as { all?: true; keys?: string[] };
    sent(res, await svc.markRead(tenantOf(req), userOf(req), body.all ? 'all' : (body.keys ?? [])), 'Marked as read');
  }),
);

notificationsRouter.post(
  '/snooze',
  validate({ body: snoozeSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    sent(res, await svc.snooze(tenantOf(req), userOf(req), (req.body as { key: string }).key), 'Hidden until 9 AM tomorrow');
  }),
);

notificationsRouter.post(
  '/unsnooze',
  validate({ body: snoozeSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    sent(res, await svc.unsnooze(tenantOf(req), userOf(req), (req.body as { key: string }).key), 'Back in the list');
  }),
);

notificationsRouter.get('/preferences', asyncHandler(async (req: Request, res: Response) => { fetched(res, await svc.prefs(tenantOf(req), userOf(req))); }));

notificationsRouter.put(
  '/preferences',
  validate({ body: prefsSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    sent(res, await svc.savePrefs(tenantOf(req), userOf(req), req.body as PrefsInput), 'Preferences saved');
  }),
);

notificationsRouter.get('/settings', requirePermission('settings', 'view'), asyncHandler(async (req: Request, res: Response) => { fetched(res, await svc.alertSettings(tenantOf(req))); }));

notificationsRouter.put(
  '/settings',
  requirePermission('settings', 'edit'),
  validate({ body: alertSettingsSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    sent(res, await svc.saveAlertSettings(tenantOf(req), await actorOf(req), req.body as AlertSettingsInput, req.ip), 'Alert settings saved');
  }),
);
