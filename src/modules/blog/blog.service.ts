import { Types } from 'mongoose';
import sharp from 'sharp';
import { AppError } from '../../core/errors';
import type { AdminActor } from '../admin/admin-auth';
import { log } from '../admin/admin.service';
import { SIGNATURES, bytesOf } from '../products/photo';
import { cleanDoc, mediaIds, plainText, sizeImages, wordCount, type DocNode } from './blog.doc';
import { BlogCategoryModel, BlogImageModel, BlogPostModel, BlogSettingModel, type BlogCategory, type BlogLang, type BlogPost } from './blog.model';
import type { AdsInput, CategoryInput, PostInput } from './blog.validation';

const PAGE = 12;
const MAX_INPUT_BYTES = 620 * 1024;
const MAX_SIDE = 1600;
const MIN_WIDTH = 400;
const WORDS_A_MINUTE = 200;

const oid = (id: string) => new Types.ObjectId(id);
const minutes = (words: number) => Math.max(1, Math.round(words / WORDS_A_MINUTE));
const nameIn = (c: Pick<BlogCategory, 'names'>, lang: BlogLang) => (lang !== 'en' && c.names[lang]) || c.names.en;
/** Live on the site: published, and its time has come (a later time = scheduled). */
const liveFilter = (now: Date) => ({ status: 'published' as const, publishedAt: { $lte: now } });

type Lean = BlogPost;
type Cat = BlogCategory;
const cover = (p: Pick<Lean, 'coverId' | 'coverAlt'>, sizes: Map<string, { width: number; height: number }>) => {
  if (!p.coverId) return null;
  const s = sizes.get(String(p.coverId));
  return { id: String(p.coverId), alt: p.coverAlt, width: s?.width ?? 1200, height: s?.height ?? 630 };
};

async function sizesOf(ids: Iterable<string>) {
  const list = [...new Set(ids)].filter((x) => /^[a-f0-9]{24}$/.test(x));
  if (!list.length) return new Map<string, { width: number; height: number }>();
  const rows = await BlogImageModel.find({ _id: { $in: list.map(oid) } }).select('width height').lean();
  return new Map(rows.map((r) => [String(r._id), { width: r.width, height: r.height }]));
}

const categoryOut = (c: Cat, lang: BlogLang = 'en') => ({ id: String(c._id), slug: c.slug, name: nameIn(c, lang), names: c.names, order: c.order });

/** A row for the lists: no body. */
function card(p: Lean, cats: Map<string, Cat>, sizes: Map<string, { width: number; height: number }>, now: Date) {
  const c = p.categoryId ? cats.get(String(p.categoryId)) : undefined;
  const lang = p.lang;
  return {
    id: String(p._id),
    slug: p.slug,
    lang,
    title: p.title,
    description: p.description,
    cover: cover(p, sizes),
    category: c ? { slug: c.slug, name: nameIn(c, lang) } : null,
    tags: p.tags,
    author: p.author,
    featured: p.featured,
    status: p.status,
    scheduled: p.status === 'published' && Boolean(p.publishedAt && p.publishedAt > now),
    publishedAt: p.publishedAt,
    updatedAt: p.updatedAt,
    minutes: minutes(p.words),
  };
}

async function categories() {
  const list = await BlogCategoryModel.find({}).sort({ order: 1, slug: 1 }).lean<Cat[]>();
  return { list, byId: new Map(list.map((c) => [String(c._id), c])) };
}

// ── Admin ──

export async function adminList(q: { q?: string; lang?: BlogLang; status?: 'draft' | 'published' }, now = new Date()) {
  const filter: Record<string, unknown> = {};
  if (q.lang) filter.lang = q.lang;
  if (q.status) filter.status = q.status;
  if (q.q) filter.title = { $regex: q.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
  const [rows, cats] = await Promise.all([BlogPostModel.find(filter).select('-content -text').sort({ updatedAt: -1 }).limit(500).lean<Lean[]>(), categories()]);
  const sizes = await sizesOf(rows.flatMap((r) => (r.coverId ? [String(r.coverId)] : [])));
  return { posts: rows.map((r) => card(r, cats.byId, sizes, now)), categories: cats.list.map((c) => ({ ...categoryOut(c), posts: rows.filter((r) => String(r.categoryId) === String(c._id)).length })) };
}

export async function adminGet(id: string, now = new Date()) {
  const p = await BlogPostModel.findById(oid(id)).lean<Lean>();
  if (!p) throw AppError.notFound('Post not found');
  const [cats, sizes] = await Promise.all([categories(), sizesOf(p.coverId ? [String(p.coverId)] : [])]);
  return { ...card(p, cats.byId, sizes, now), categoryId: p.categoryId ? String(p.categoryId) : null, coverId: p.coverId ? String(p.coverId) : null, coverAlt: p.coverAlt, content: p.content as DocNode, words: p.words };
}

async function shape(input: PostInput, now: Date) {
  if (input.categoryId && !(await BlogCategoryModel.exists({ _id: oid(input.categoryId) }))) throw AppError.validation('That category is gone — pick another', [{ field: 'body.categoryId', message: 'Pick a category' }]);
  if (input.coverId && !(await BlogImageModel.exists({ _id: oid(input.coverId) }))) throw AppError.validation('The cover picture is gone — upload it again', [{ field: 'body.coverId', message: 'Upload the cover again' }]);
  const content = cleanDoc(input.content);
  const text = plainText(content).replace(/\s+/g, ' ').trim();
  const words = wordCount(text);
  if (words < 30) throw AppError.validation('Write at least 30 words', [{ field: 'body.content', message: 'Write at least 30 words' }]);
  return {
    slug: input.slug,
    lang: input.lang,
    title: input.title,
    description: input.description,
    content,
    text: text.slice(0, 20_000),
    words,
    categoryId: input.categoryId ? oid(input.categoryId) : null,
    coverId: input.coverId ? oid(input.coverId) : null,
    coverAlt: input.coverAlt,
    tags: input.tags,
    author: input.author,
    featured: input.featured,
    status: input.status,
    // Publishing without a time means now; a draft keeps the time it was given (or none).
    publishedAt: input.status === 'published' ? (input.publishedAt ?? now) : input.publishedAt,
  };
}

const taken = (err: unknown) => (err as { code?: number }).code === 11000;
const slugTaken = (lang: string) => AppError.conflict(`A ${lang.toUpperCase()} post already has this web address — change the slug`, { reason: 'SLUG_TAKEN' });

export async function createPost(a: AdminActor, input: PostInput, ip?: string, now = new Date()) {
  const doc = await shape(input, now);
  try {
    const p = await BlogPostModel.create({ ...doc, createdBy: a.name, updatedBy: a.name });
    await log(a, 'blog_post_created', 'blog post', `wrote “${p.title}” (${p.lang}, ${p.status})`, undefined, undefined, ip);
    return await adminGet(String(p._id), now);
  } catch (err) {
    if (taken(err)) throw slugTaken(input.lang);
    throw err;
  }
}

export async function updatePost(a: AdminActor, id: string, input: PostInput, ip?: string, now = new Date()) {
  const doc = await shape(input, now);
  try {
    const p = await BlogPostModel.findByIdAndUpdate(oid(id), { $set: { ...doc, updatedBy: a.name } }, { returnDocument: 'after' }).lean<Lean>();
    if (!p) throw AppError.notFound('Post not found');
    await log(a, 'blog_post_updated', 'blog post', `edited “${p.title}” (${p.lang}, ${p.status})`, undefined, undefined, ip);
    return await adminGet(id, now);
  } catch (err) {
    if (taken(err)) throw slugTaken(input.lang);
    throw err;
  }
}

export async function setFeatured(a: AdminActor, id: string, featured: boolean, ip?: string, now = new Date()) {
  const p = await BlogPostModel.findByIdAndUpdate(oid(id), { $set: { featured, updatedBy: a.name } }, { returnDocument: 'after', timestamps: false }).lean<Lean>();
  if (!p) throw AppError.notFound('Post not found');
  await log(a, 'blog_post_featured', 'blog post', `${featured ? 'featured' : 'took off featured'} “${p.title}”`, undefined, undefined, ip);
  return adminGet(id, now);
}

/** Pictures a post used and no other post uses are removed with it. */
export async function removePost(a: AdminActor, id: string, reason: string, ip?: string) {
  const p = await BlogPostModel.findByIdAndDelete(oid(id)).lean<Lean>();
  if (!p) throw AppError.notFound('Post not found');
  const ids = mediaIds(p.content as DocNode);
  if (p.coverId) ids.add(String(p.coverId));
  const others = await BlogPostModel.find({}).select('coverId content').lean<Lean[]>();
  const used = new Set(others.flatMap((o) => [...mediaIds(o.content as DocNode), ...(o.coverId ? [String(o.coverId)] : [])]));
  const gone = [...ids].filter((x) => !used.has(x));
  if (gone.length) await BlogImageModel.deleteMany({ _id: { $in: gone.map(oid) } });
  await log(a, 'blog_post_removed', reason, `removed “${p.title}” (${p.lang})`, undefined, undefined, ip);
  return { id, pictures: gone.length };
}

export async function saveCategory(a: AdminActor, id: string | null, input: CategoryInput, ip?: string) {
  try {
    const c = id
      ? await BlogCategoryModel.findByIdAndUpdate(oid(id), { $set: input }, { returnDocument: 'after' }).lean<Cat>()
      : (await BlogCategoryModel.create(input)).toObject<Cat>();
    if (!c) throw AppError.notFound('Category not found');
    await log(a, id ? 'blog_category_updated' : 'blog_category_created', 'blog category', `${id ? 'renamed' : 'added'} category “${c.names.en}”`, undefined, undefined, ip);
    return categoryOut(c);
  } catch (err) {
    if (taken(err)) throw AppError.conflict('A category already has this web address', { reason: 'SLUG_TAKEN' });
    throw err;
  }
}

export async function removeCategory(a: AdminActor, id: string, reason: string, ip?: string) {
  const n = await BlogPostModel.countDocuments({ categoryId: oid(id) });
  if (n) throw AppError.conflict(`${String(n)} ${n === 1 ? 'post is' : 'posts are'} in this category — move them first`, { reason: 'HAS_POSTS' });
  const c = await BlogCategoryModel.findByIdAndDelete(oid(id)).lean<Cat>();
  if (!c) throw AppError.notFound('Category not found');
  await log(a, 'blog_category_removed', reason, `removed category “${c.names.en}”`, undefined, undefined, ip);
  return { id };
}

const badImage = (message: string) => AppError.validation(message, [{ field: 'body.image', message }]);

/** An uploaded picture → WebP, at most 1600 px wide; refuses what is not really an image. */
export async function uploadImage(a: AdminActor, dataUrl: string) {
  const m = /^data:(image\/(?:webp|jpeg|png));base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!m?.[1] || !m[2]) throw badImage('Use a PNG, JPEG or WebP picture');
  const input = Buffer.from(m[2], 'base64');
  if (input.length > MAX_INPUT_BYTES) throw badImage('The picture is larger than 600 KB');
  if (!SIGNATURES[m[1]]?.(input)) throw badImage('That file is not the picture it claims to be');
  try {
    const meta = await sharp(input, { limitInputPixels: 6000 * 6000, failOn: 'error' }).metadata();
    if (meta.width < MIN_WIDTH) throw badImage(`The picture is ${String(meta.width)} px wide — use ${String(MIN_WIDTH)} px or more (1200 for a cover)`);
    const { data, info } = await sharp(input, { limitInputPixels: 6000 * 6000 }).rotate().resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true }).webp({ quality: 80 }).toBuffer({ resolveWithObject: true });
    const img = await BlogImageModel.create({ data, width: info.width, height: info.height, createdBy: a.name });
    return { id: String(img._id), width: info.width, height: info.height, bytes: data.length };
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw badImage('That picture could not be read');
  }
}

export async function image(id: string) {
  const img = await BlogImageModel.findById(oid(id)).select('data').lean();
  return bytesOf(img?.data);
}

export async function ads() {
  const s = await BlogSettingModel.findById('blog').lean();
  return { adsOn: s?.adsOn ?? false, adClient: s?.adClient ?? '', slotList: s?.slotList ?? '', slotArticle: s?.slotArticle ?? '', updatedBy: s?.updatedBy ?? null, updatedAt: s?.updatedAt ?? null };
}

export async function saveAds(a: AdminActor, input: AdsInput, ip?: string) {
  const { reason, ...set } = input;
  await BlogSettingModel.updateOne({ _id: 'blog' }, { $set: { ...set, updatedBy: a.name } }, { upsert: true });
  await log(a, 'blog_ads', reason, `${set.adsOn ? 'turned on' : 'turned off'} blog ads (${set.adClient || 'no publisher id'})`, undefined, undefined, ip);
  return ads();
}

// ── Public ──

/** What the public pages need to show ads: nothing at all while they are off. */
export async function publicAds() {
  const s = await ads();
  return s.adsOn && s.adClient ? { on: true, client: s.adClient, slotList: s.slotList || null, slotArticle: s.slotArticle || null } : { on: false, client: null, slotList: null, slotArticle: null };
}

export async function publicList(q: { lang: BlogLang; page: number; tag?: string; category?: string }, now = new Date()) {
  const cats = await categories();
  const cat = q.category ? cats.list.find((c) => c.slug === q.category) : undefined;
  if (q.category && !cat) throw AppError.notFound('No such category');
  const filter: Record<string, unknown> = { ...liveFilter(now), lang: q.lang, ...(q.tag ? { tags: q.tag } : {}), ...(cat ? { categoryId: cat._id } : {}) };
  const [rows, total, featured, counts] = await Promise.all([
    BlogPostModel.find(filter).select('-content -text').sort({ publishedAt: -1 }).skip((q.page - 1) * PAGE).limit(PAGE).lean<Lean[]>(),
    BlogPostModel.countDocuments(filter),
    q.page === 1 && !q.tag && !cat ? BlogPostModel.find({ ...liveFilter(now), lang: q.lang, featured: true }).select('-content -text').sort({ publishedAt: -1 }).limit(3).lean<Lean[]>() : Promise.resolve([] as Lean[]),
    BlogPostModel.aggregate<{ _id: Types.ObjectId | null; n: number }>([{ $match: { ...liveFilter(now), lang: q.lang } }, { $group: { _id: '$categoryId', n: { $sum: 1 } } }]),
  ]);
  const sizes = await sizesOf([...rows, ...featured].flatMap((r) => (r.coverId ? [String(r.coverId)] : [])));
  const n = new Map(counts.map((c) => [String(c._id), c.n]));
  return {
    lang: q.lang,
    page: q.page,
    pages: Math.max(1, Math.ceil(total / PAGE)),
    total,
    category: cat ? categoryOut(cat, q.lang) : null,
    tag: q.tag ?? null,
    featured: featured.map((r) => card(r, cats.byId, sizes, now)),
    posts: rows.map((r) => card(r, cats.byId, sizes, now)),
    categories: cats.list.filter((c) => n.get(String(c._id))).map((c) => ({ ...categoryOut(c, q.lang), posts: n.get(String(c._id)) ?? 0 })),
  };
}

/** A live post, its other languages, and three to read next: same category first, then shared tags, then the newest. */
export async function publicPost(lang: BlogLang, slug: string, now = new Date()) {
  const p = await BlogPostModel.findOne({ ...liveFilter(now), lang, slug }).lean<Lean>();
  if (!p) throw AppError.notFound('Post not found');
  const base = { ...liveFilter(now), lang, _id: { $ne: p._id } };
  const pick = '-content -text';
  const [cats, translations, sameCat, sameTags, newest] = await Promise.all([
    categories(),
    BlogPostModel.find({ ...liveFilter(now), slug, lang: { $ne: lang } }).select('lang slug').lean(),
    p.categoryId ? BlogPostModel.find({ ...base, categoryId: p.categoryId }).select(pick).sort({ publishedAt: -1 }).limit(3).lean<Lean[]>() : Promise.resolve([] as Lean[]),
    p.tags.length ? BlogPostModel.find({ ...base, tags: { $in: p.tags } }).select(pick).sort({ publishedAt: -1 }).limit(3).lean<Lean[]>() : Promise.resolve([] as Lean[]),
    BlogPostModel.find(base).select(pick).sort({ publishedAt: -1 }).limit(3).lean<Lean[]>(),
  ]);
  const seen = new Set<string>();
  const related = [...sameCat, ...sameTags, ...newest].filter((r) => (seen.has(String(r._id)) ? false : (seen.add(String(r._id)), true))).slice(0, 3);
  const content = p.content as DocNode;
  const sizes = await sizesOf([...mediaIds(content), ...[p, ...related].flatMap((r) => (r.coverId ? [String(r.coverId)] : []))]);
  return {
    ...card(p, cats.byId, sizes, now),
    content: sizeImages(content, sizes),
    words: p.words,
    translations: translations.map((t) => ({ lang: t.lang, slug: t.slug })),
    related: related.map((r) => card(r, cats.byId, sizes, now)),
  };
}

/** Every live post, for the sitemap, the feed and llms.txt. */
export async function publicIndex(now = new Date()) {
  const [rows, cats] = await Promise.all([BlogPostModel.find(liveFilter(now)).select('lang slug title description publishedAt updatedAt categoryId').sort({ publishedAt: -1 }).limit(5000).lean<Lean[]>(), categories()]);
  return {
    posts: rows.map((r) => ({ lang: r.lang, slug: r.slug, title: r.title, description: r.description, publishedAt: r.publishedAt, updatedAt: r.updatedAt, category: r.categoryId ? (cats.byId.get(String(r.categoryId))?.slug ?? null) : null })),
    categories: cats.list.map((c) => ({ slug: c.slug, langs: [...new Set(rows.filter((r) => String(r.categoryId) === String(c._id)).map((r) => r.lang))] })),
  };
}
