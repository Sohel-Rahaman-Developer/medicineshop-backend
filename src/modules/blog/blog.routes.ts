import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../core/async-handler';
import { AppError } from '../../core/errors';
import { validate } from '../../core/middleware/validate';
import { created, fetched, sent } from '../../core/response';
import { idParams } from '../../core/zod';
import { adminOf, requireAdminRole } from '../admin/admin-auth';
import { BLOG_LANGS, type BlogLang } from './blog.model';
import * as svc from './blog.service';
import { adminListQuery, adsSchema, categorySchema, listQuery, postSchema, removeSchema, slug, type AdsInput, type CategoryInput, type PostInput } from './blog.validation';

const superOnly = requireAdminRole('super');
const id = (req: Request) => (req.params as { id: string }).id;

/** D115: the console's blog — every admin reads, the super admin writes. Mounted after requireAdmin. */
export const blogAdminRouter = Router();

blogAdminRouter.get('/posts', validate({ query: adminListQuery }), asyncHandler(async (req: Request, res: Response) => { fetched(res, await svc.adminList(req.query)); }));
blogAdminRouter.get('/posts/:id', validate({ params: idParams }), asyncHandler(async (req: Request, res: Response) => { fetched(res, await svc.adminGet(id(req))); }));
blogAdminRouter.post('/posts', superOnly, validate({ body: postSchema }), asyncHandler(async (req: Request, res: Response) => { const p = await svc.createPost(adminOf(req), req.body as PostInput, req.ip); created(res, p, p.status === 'draft' ? 'Draft saved' : p.scheduled ? 'Scheduled' : 'Published'); }));
blogAdminRouter.put('/posts/:id', superOnly, validate({ params: idParams, body: postSchema }), asyncHandler(async (req: Request, res: Response) => { const p = await svc.updatePost(adminOf(req), id(req), req.body as PostInput, req.ip); sent(res, p, p.status === 'draft' ? 'Draft saved' : p.scheduled ? 'Scheduled' : 'Saved — live on the blog'); }));
blogAdminRouter.put('/posts/:id/featured', superOnly, validate({ params: idParams, body: z.object({ featured: z.boolean() }).strict() }), asyncHandler(async (req: Request, res: Response) => { const f = (req.body as { featured: boolean }).featured; sent(res, await svc.setFeatured(adminOf(req), id(req), f, req.ip), f ? 'Featured' : 'No longer featured'); }));
blogAdminRouter.delete('/posts/:id', superOnly, validate({ params: idParams, body: removeSchema }), asyncHandler(async (req: Request, res: Response) => { sent(res, await svc.removePost(adminOf(req), id(req), (req.body as { reason: string }).reason, req.ip), 'Post deleted'); }));

blogAdminRouter.post('/categories', superOnly, validate({ body: categorySchema }), asyncHandler(async (req: Request, res: Response) => { created(res, await svc.saveCategory(adminOf(req), null, req.body as CategoryInput, req.ip), 'Category added'); }));
blogAdminRouter.put('/categories/:id', superOnly, validate({ params: idParams, body: categorySchema }), asyncHandler(async (req: Request, res: Response) => { sent(res, await svc.saveCategory(adminOf(req), id(req), req.body as CategoryInput, req.ip), 'Category saved'); }));
blogAdminRouter.delete('/categories/:id', superOnly, validate({ params: idParams, body: removeSchema }), asyncHandler(async (req: Request, res: Response) => { sent(res, await svc.removeCategory(adminOf(req), id(req), (req.body as { reason: string }).reason, req.ip), 'Category removed'); }));

blogAdminRouter.post('/images', superOnly, validate({ body: z.object({ image: z.string().max(860_000) }).strict() }), asyncHandler(async (req: Request, res: Response) => { created(res, await svc.uploadImage(adminOf(req), (req.body as { image: string }).image), 'Picture uploaded'); }));

blogAdminRouter.get('/ads', asyncHandler(async (_req: Request, res: Response) => { fetched(res, await svc.ads()); }));
blogAdminRouter.put('/ads', superOnly, validate({ body: adsSchema }), asyncHandler(async (req: Request, res: Response) => { const a = await svc.saveAds(adminOf(req), req.body as AdsInput, req.ip); sent(res, a, a.adsOn ? 'Ads on — they show on blog pages' : 'Ads off'); }));

/** Public: the blog for the website (live posts only), its pictures and whether ads show. */
export const blogRouter = Router();

blogRouter.get('/posts', validate({ query: listQuery }), asyncHandler(async (req: Request, res: Response) => { fetched(res, await svc.publicList(req.query as unknown as z.infer<typeof listQuery>)); }));
blogRouter.get('/posts/:lang/:slug', validate({ params: z.object({ lang: z.enum(BLOG_LANGS), slug }).strict() }), asyncHandler(async (req: Request, res: Response) => { const p = req.params as { lang: BlogLang; slug: string }; fetched(res, await svc.publicPost(p.lang, p.slug)); }));
blogRouter.get('/index', asyncHandler(async (_req: Request, res: Response) => { fetched(res, await svc.publicIndex()); }));
blogRouter.get('/ads', asyncHandler(async (_req: Request, res: Response) => { fetched(res, await svc.publicAds()); }));
blogRouter.get(
  '/img/:file',
  validate({ params: z.object({ file: z.string().regex(/^[a-f0-9]{24}(\.webp)?$/) }).strict() }),
  asyncHandler(async (req: Request, res: Response) => {
    const body = await svc.image((req.params as { file: string }).file.slice(0, 24));
    if (!body) throw AppError.notFound('Picture not found');
    // An id never gets another picture, so it is cached for a year.
    res.set({ 'Content-Type': 'image/webp', 'Cache-Control': 'public, max-age=31536000, immutable', 'Cross-Origin-Resource-Policy': 'cross-origin' });
    // A stored WebP with its own fixed type, never HTML.
    res.send(body); // nosemgrep
  }),
);
