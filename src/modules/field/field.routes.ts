import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../core/async-handler';
import { otpRequestByEmailLimiter, otpRequestByIpLimiter, otpVerifyLimiter } from '../../core/middleware/rate-limit';
import { validate } from '../../core/middleware/validate';
import { created, fetched, sent } from '../../core/response';
import { idParams } from '../../core/zod';
import { STATES } from '../../utils/india';
import { draftShopSchema, mobile, ownerSchema } from '../shops/shops.validation';
import { fieldOf, me, passwordLogin, requestCode, requireField, setPassword, signOut, verifyCode } from './field-auth';
import * as svc from './field.service';

// D100: the field staff portal's API — its own sign-in and cookie, nothing of the admin console.
export const fieldRouter = Router();

const email = z.email('Enter a valid email address').trim().toLowerCase();
const password = z.string().min(8, 'At least 8 characters').max(72, 'At most 72 characters');

fieldRouter.post('/auth/code', otpRequestByIpLimiter, otpRequestByEmailLimiter, validate({ body: z.object({ email }).strict() }), asyncHandler(async (req: Request, res: Response) => {
  sent(res, await requestCode((req.body as { email: string }).email, req.ip), 'If this email is MedBox24 staff, a code is on its way');
}));
fieldRouter.post('/auth/verify', otpVerifyLimiter, validate({ body: z.object({ email, otp: z.string().regex(/^\d{4,8}$/) }).strict() }), asyncHandler(async (req: Request, res: Response) => {
  const b = req.body as { email: string; otp: string };
  sent(res, await verifyCode(req, res, b.email, b.otp), 'Signed in');
}));
fieldRouter.post('/auth/password', otpVerifyLimiter, validate({ body: z.object({ email, password: z.string().min(1).max(72) }).strict() }), asyncHandler(async (req: Request, res: Response) => {
  const b = req.body as { email: string; password: string };
  sent(res, await passwordLogin(req, res, b.email, b.password), 'Signed in');
}));
fieldRouter.post('/auth/logout', asyncHandler(async (req: Request, res: Response) => {
  await signOut(req, res);
  sent(res, { ok: true }, 'Signed out');
}));

fieldRouter.use(requireField);

fieldRouter.get('/me', asyncHandler(async (req: Request, res: Response) => { fetched(res, { ...(await me(fieldOf(req).id)), method: fieldOf(req).method, states: STATES.map((x) => x.name) }); }));
fieldRouter.put('/me', validate({ body: z.object({ name: z.string().trim().min(2, 'Your name').max(80), phone: mobile('Your phone') }).strict() }), asyncHandler(async (req: Request, res: Response) => {
  await svc.saveProfile(fieldOf(req), req.body as { name: string; phone: string });
  sent(res, await me(fieldOf(req).id), 'Saved');
}));
fieldRouter.put('/me/password', validate({ body: z.object({ password, current: z.string().max(72).optional() }).strict() }), asyncHandler(async (req: Request, res: Response) => {
  const b = req.body as { password: string; current?: string };
  await setPassword(fieldOf(req), b.password, b.current);
  sent(res, await me(fieldOf(req).id), 'Password saved — your other sign-ins were signed out');
}));
fieldRouter.get('/shops', asyncHandler(async (req: Request, res: Response) => { fetched(res, await svc.myShops(fieldOf(req))); }));
fieldRouter.post('/drafts', validate({ body: z.object({ email, owner: ownerSchema, shop: draftShopSchema }).strict() }), asyncHandler(async (req: Request, res: Response) => {
  const d = await svc.createDraft(fieldOf(req), req.body as svc.DraftInput);
  created(res, d, `Sent to ${d.email} — the shop starts when the owner signs in and agrees`);
}));
fieldRouter.delete('/drafts/:id', validate({ params: idParams }), asyncHandler(async (req: Request, res: Response) => {
  await svc.cancelDraft(fieldOf(req), (req.params as { id: string }).id);
  sent(res, null, 'Cancelled');
}));
