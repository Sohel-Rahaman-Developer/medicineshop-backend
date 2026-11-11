import { z } from 'zod';
import { objectId } from '../../core/zod';
import { BLOG_LANGS, POST_STATUS } from './blog.model';

const SLUG_HINT = 'Small English letters, numbers and dashes, like gst-on-medicines';
export const slug = z.string().trim().toLowerCase().min(3).max(80).regex(/^[a-z0-9-]+$/, SLUG_HINT).refine((s) => !s.startsWith('-') && !s.endsWith('-') && !s.includes('--'), SLUG_HINT);
const reason = z.string().trim().min(5, 'Say why (5 letters at least)').max(300);

export const postSchema = z
  .object({
    slug,
    lang: z.enum(BLOG_LANGS),
    title: z.string().trim().min(10, 'A title of 10 letters or more').max(110),
    description: z.string().trim().min(50, 'A summary of 50 letters or more — search engines show it').max(170),
    /** The editor's document (TipTap JSON); cleaned by `cleanDoc` before it is kept. */
    content: z.looseObject({ type: z.literal('doc'), content: z.array(z.unknown()).max(2000) }),
    categoryId: objectId.nullable().default(null),
    coverId: objectId.nullable().default(null),
    coverAlt: z.string().trim().max(140).default(''),
    tags: z.array(z.string().trim().toLowerCase().min(2).max(30)).max(6).default([]).refine((t) => new Set(t).size === t.length, 'Each tag once'),
    author: z.string().trim().min(2).max(60).default('MedBox24 team'),
    featured: z.boolean().default(false),
    status: z.enum(POST_STATUS),
    publishedAt: z.coerce.date().nullable().default(null),
  })
  .strict()
  .refine((p) => !p.coverId || p.coverAlt.length >= 5, { message: 'Say what the cover picture shows (5 letters or more)', path: ['coverAlt'] });
export type PostInput = z.infer<typeof postSchema>;

export const adsSchema = z
  .object({
    adsOn: z.boolean(),
    adClient: z.string().trim().max(40).refine((v) => v === '' || /^ca-pub-\d{10,20}$/.test(v), 'Like ca-pub-1234567890123456 — from AdSense → Account → Account information'),
    slotList: z.string().trim().max(20).refine((v) => v === '' || /^\d{6,20}$/.test(v), 'Only the number from the ad unit'),
    slotArticle: z.string().trim().max(20).refine((v) => v === '' || /^\d{6,20}$/.test(v), 'Only the number from the ad unit'),
    reason,
  })
  .strict()
  .refine((a) => !a.adsOn || a.adClient !== '', { message: 'Put the publisher id first', path: ['adClient'] });
export type AdsInput = z.infer<typeof adsSchema>;

export const listQuery = z.object({ lang: z.enum(BLOG_LANGS).default('en'), page: z.coerce.number().int().min(1).max(500).default(1), tag: z.string().trim().toLowerCase().max(30).optional(), category: slug.optional() }).strict();

export const categorySchema = z
  .object({
    slug,
    names: z.object({ en: z.string().trim().min(2).max(40), hi: z.string().trim().max(40).default(''), bn: z.string().trim().max(40).default('') }).strict(),
    order: z.number().int().min(0).max(999).default(0),
  })
  .strict();
export type CategoryInput = z.infer<typeof categorySchema>;
export const adminListQuery = z.object({ q: z.string().trim().max(80).optional(), lang: z.enum(BLOG_LANGS).optional(), status: z.enum(POST_STATUS).optional() }).strict();
export const removeSchema = z.object({ reason }).strict();
