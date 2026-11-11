// D115 checks: the blog — categories, pictures, drafts, publish now or later, featured, related posts, translations,
// what reaches the public (clean content only), ads settings, delete, and that only the super admin writes.
import { check, crash, finish, section, startHarness, type Res } from './lib/harness';

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- test helper: the caller names the shape
const data = <T>(r: Res) => r.json.data as T;
const code = (r: Res) => `${String(r.status)} ${r.json.error?.code ?? ''} ${r.json.error?.message ?? ''}`;
const reason = (r: Res) => (r.json.error?.details as { reason?: string } | undefined)?.reason;
const wait = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

interface Card { id: string; slug: string; lang: string; title: string; featured: boolean; status: string; scheduled: boolean; minutes: number; category: { slug: string; name: string } | null; cover: { id: string; width: number; height: number; alt: string } | null }
interface Doc { type: string; text?: string; attrs?: Record<string, unknown>; marks?: { type: string; attrs?: { href?: string } }[]; content?: Doc[] }
interface Post extends Card { content: Doc; translations: { lang: string; slug: string }[]; related: Card[] }
interface List { posts: Card[]; featured: Card[]; categories: { slug: string; name: string; posts: number }[]; pages: number; total: number; category: { slug: string } | null }

const para = (text: string, marks?: unknown[]) => ({ type: 'paragraph', content: [{ type: 'text', text, ...(marks ? { marks } : {}) }] });
const words = (n: number, w = 'medicine') => Array.from({ length: n }, () => w).join(' ');
const doc = (...content: unknown[]) => ({ type: 'doc', content });

async function main() {
  const h = await startHarness();
  const sharp = (await import('sharp')).default;
  const { AdminUserModel, AdminAuditModel } = await import('../src/modules/admin/admin.model.js');
  const { BlogPostModel, BlogImageModel } = await import('../src/modules/blog/blog.model.js');
  const { totpAt } = await import('../src/utils/totp.js');
  const step = () => Math.floor(Date.now() / 30_000);
  const login = async (email: string) => {
    const c = h.client({ origin: 'http://localhost:3001' });
    await h.seedOtp(email, '135790', 'admin');
    const s = data<{ secret?: string }>(await c.post('/admin/auth/verify', { email, otp: '135790' })).secret ?? '';
    await c.post('/admin/auth/totp', { code: totpAt(s, step()) });
    return c;
  };
  await AdminUserModel.create([{ email: 'root@blog.test', name: 'Root', role: 'super' }, { email: 'viewer@blog.test', name: 'Vik', role: 'viewer' }]);
  const root = await login('root@blog.test');
  const viewer = await login('viewer@blog.test');
  const pub = h.client({ origin: 'http://localhost:3000' });
  const png = async (w: number, hgt: number) => `data:image/png;base64,${(await sharp({ create: { width: w, height: hgt, channels: 3, background: { r: 14, g: 116, b: 144 } } }).png().toBuffer()).toString('base64')}`;

  section('1. Categories');
  const gst = await root.post('/admin/blog/categories', { slug: 'gst', names: { en: 'GST and tax', hi: 'GST और टैक्स', bn: '' } });
  check('the super admin adds a category', gst.status === 201, code(gst));
  const gstId = data<{ id: string }>(gst).id;
  const stock = data<{ id: string }>(await root.post('/admin/blog/categories', { slug: 'stock', names: { en: 'Stock and expiry' }, order: 2 })).id;
  check('the same web address twice → 409', (await root.post('/admin/blog/categories', { slug: 'gst', names: { en: 'Again' } })).status === 409);
  check('a viewer cannot add one → 403', (await viewer.post('/admin/blog/categories', { slug: 'other', names: { en: 'Other' } })).status === 403);
  check('a bad web address → 422', (await root.post('/admin/blog/categories', { slug: 'GST Tax!', names: { en: 'Bad' } })).status === 422);

  section('2. Pictures');
  const up = await root.post('/admin/blog/images', { image: await png(1300, 700) });
  const cover = data<{ id: string; width: number; height: number }>(up);
  check('a picture uploads as WebP, kept at its size (≤ 1600 px)', up.status === 201 && cover.width === 1300 && cover.height === 700, code(up));
  const big = data<{ width: number }>(await root.post('/admin/blog/images', { image: await png(2400, 1200) }));
  check('a wide picture is brought down to 1600 px', big.width === 1600);
  const inline = data<{ id: string }>(await root.post('/admin/blog/images', { image: await png(800, 500) })).id;
  check('too narrow (300 px) → 422', (await root.post('/admin/blog/images', { image: await png(300, 300) })).status === 422);
  check('a file that is not what it says → 422', (await root.post('/admin/blog/images', { image: `data:image/png;base64,${Buffer.from('<script>alert(1)</script>').toString('base64')}` })).status === 422);
  check('a viewer cannot upload → 403', (await viewer.post('/admin/blog/images', { image: await png(800, 500) })).status === 403);
  const img = await pub.raw('GET', `/blog/img/${cover.id}.webp`);
  check('anyone reads it as image/webp, cached for a year', img.status === 200 && img.headers.get('content-type') === 'image/webp' && (img.headers.get('cache-control') ?? '').includes('immutable'));
  check('an unknown picture → 404', (await pub.raw('GET', `/blog/img/${'0'.repeat(24)}`)).status === 404);

  section('3. Write, draft, publish');
  const body = (over: Record<string, unknown> = {}) => ({
    slug: 'gst-on-medicines',
    lang: 'en',
    title: 'GST on medicines in 2026: rates and HSN codes',
    description: 'Which GST rate applies to which medicine, the HSN codes, and how a medical store splits CGST and SGST on every bill.',
    content: doc(
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'The rates' }] },
      para(words(120)),
      para('Read the free calculator', [{ type: 'link', attrs: { href: '/tools/medicine-gst-calculator' } }]),
      para('Click me', [{ type: 'link', attrs: { href: 'javascript:alert(document.cookie)' } }]),
      { type: 'image', attrs: { src: `media:${inline}`, alt: 'A GST bill', onerror: 'alert(1)' } },
      { type: 'rawHtml', attrs: { html: '<img src=x onerror=alert(1)>' } },
    ),
    categoryId: gstId,
    coverId: cover.id,
    coverAlt: 'A pharmacist making a GST bill',
    tags: ['gst', 'hsn'],
    featured: false,
    status: 'draft',
    publishedAt: null,
    ...over,
  });
  const d1 = await root.post('/admin/blog/posts', body());
  const first = data<Post & { words: number }>(d1);
  check('a draft is saved', d1.status === 201 && first.status === 'draft' && d1.json.message === 'Draft saved', code(d1));
  const raw = JSON.stringify(first.content);
  check('only clean content is kept: no javascript: link, no unknown block, no onerror', !raw.includes('javascript') && !raw.includes('rawHtml') && !raw.includes('onerror') && raw.includes('/tools/medicine-gst-calculator'));
  check('words counted for the read time', first.words >= 120 && first.minutes === 1, String(first.words));
  check('a draft is not on the site', data<List>(await pub.get('/blog/posts?lang=en')).total === 0 && (await pub.get('/blog/posts/en/gst-on-medicines')).status === 404);
  check('a viewer cannot write → 403', (await viewer.post('/admin/blog/posts', body({ slug: 'viewer-post' }))).status === 403);
  check('too short (under 30 words) → 422', (await root.post('/admin/blog/posts', body({ slug: 'short', content: doc(para('Too short')) }))).status === 422);
  check('a cover without saying what it shows → 422', (await root.post('/admin/blog/posts', body({ slug: 'no-alt', coverAlt: '' }))).status === 422);
  check('a summary too short for search → 422', (await root.post('/admin/blog/posts', body({ slug: 'no-desc', description: 'Short' }))).status === 422);
  const dup = await root.post('/admin/blog/posts', body());
  check('the same web address in the same language → 409 SLUG_TAKEN', dup.status === 409 && reason(dup) === 'SLUG_TAKEN', code(dup));

  const pubd = await root.put(`/admin/blog/posts/${first.id}`, body({ status: 'published' }));
  check('publish now: live at once', pubd.status === 200 && data<Card>(pubd).status === 'published' && !data<Card>(pubd).scheduled, code(pubd));
  const live = data<Post>(await pub.get('/blog/posts/en/gst-on-medicines'));
  check('the public post carries its category, cover size and clean content', live.category?.slug === 'gst' && live.cover?.width === 1300 && !JSON.stringify(live.content).includes('javascript'));
  const pic = live.content.content?.find((n) => n.type === 'image');
  check('a picture in the text has its width and height (no jump while it loads)', pic?.attrs?.width === 800 && pic.attrs.height === 500);

  section('4. Schedule: live when its time comes');
  const soon = new Date(Date.now() + 1500);
  const sch = await root.post('/admin/blog/posts', body({ slug: 'expiry-returns', title: 'How to return near-expiry medicines to the supplier', categoryId: stock, tags: ['expiry'], coverId: null, coverAlt: '', status: 'published', publishedAt: soon.toISOString() }));
  check('a later time → scheduled, not live yet', sch.status === 201 && data<Card>(sch).scheduled && sch.json.message === 'Scheduled', code(sch));
  check('not on the site before its time', (await pub.get('/blog/posts/en/expiry-returns')).status === 404);
  await wait(1800);
  check('on the site once the time has passed — nobody pressed anything', (await pub.get('/blog/posts/en/expiry-returns')).status === 200);

  section('5. Featured, lists, categories, tags, pages');
  check('a viewer cannot feature → 403', (await viewer.put(`/admin/blog/posts/${first.id}/featured`, { featured: true })).status === 403);
  await root.put(`/admin/blog/posts/${first.id}/featured`, { featured: true });
  for (let i = 0; i < 12; i += 1) await root.post('/admin/blog/posts', body({ slug: `stock-tip-${String(i)}`, title: `Stock tip number ${String(i)} for a medical store`, categoryId: stock, tags: ['stock'], coverId: null, coverAlt: '', status: 'published', publishedAt: new Date(Date.now() - (i + 1) * 3_600_000).toISOString() }));
  const l1 = data<List>(await pub.get('/blog/posts?lang=en'));
  check('page 1: 12 posts, 2 pages, the featured one on top', l1.posts.length === 12 && l1.pages === 2 && l1.total === 14 && l1.featured[0]?.slug === 'gst-on-medicines', `${String(l1.total)} ${String(l1.pages)}`);
  check('categories with their counts', l1.categories.find((c) => c.slug === 'stock')?.posts === 13 && l1.categories.find((c) => c.slug === 'gst')?.posts === 1);
  const byCat = data<List>(await pub.get('/blog/posts?lang=en&category=gst'));
  check('a category page lists only its posts, no featured row', byCat.total === 1 && byCat.category?.slug === 'gst' && byCat.featured.length === 0);
  check('a tag page', data<List>(await pub.get('/blog/posts?lang=en&tag=expiry')).total === 1);
  check('an unknown category → 404', (await pub.get('/blog/posts?lang=en&category=nothing')).status === 404);
  check('a category with posts cannot be removed → 409 HAS_POSTS', reason(await root.del(`/admin/blog/categories/${stock}`, { reason: 'Clean up the list' })) === 'HAS_POSTS');

  section('6. Related posts and translations');
  const tip = data<Post>(await pub.get('/blog/posts/en/stock-tip-0'));
  check('three to read next, from the same category first', tip.related.length === 3 && tip.related.every((r) => r.category?.slug === 'stock' && r.slug !== 'stock-tip-0'));
  const hi = await root.post('/admin/blog/posts', body({ lang: 'hi', title: 'दवाओं पर GST 2026: रेट और HSN कोड', description: 'किस दवा पर कितना GST लगता है, HSN कोड क्या हैं, और मेडिकल स्टोर हर बिल पर CGST और SGST कैसे बाँटता है।', content: doc(para(words(60, 'दवा'))), status: 'published' }));
  check('the same web address in Hindi is the translation', hi.status === 201, code(hi));
  const en = data<Post>(await pub.get('/blog/posts/en/gst-on-medicines'));
  check('each says where the other language is', en.translations.some((x) => x.lang === 'hi' && x.slug === 'gst-on-medicines'));
  const hiList = data<List>(await pub.get('/blog/posts?lang=hi'));
  check('a Hindi list holds Hindi posts, the category in Hindi', hiList.total === 1 && hiList.posts[0]?.category?.name === 'GST और टैक्स');

  section('7. A long Hindi post fits (bigger body than the usual 100 KB)');
  const long = await root.post('/admin/blog/posts', body({ slug: 'long-hindi', lang: 'hi', title: 'मेडिकल स्टोर कैसे खोलें: पूरी गाइड', description: 'ड्रग लाइसेंस, फ़ार्मासिस्ट, दुकान का नाप, GST और पहला स्टॉक — मेडिकल स्टोर खोलने की पूरी गाइड हिंदी में।', content: doc(...Array.from({ length: 60 }, () => para('दवा '.repeat(700)))), coverId: null, coverAlt: '', status: 'draft' }));
  check('a 60-paragraph Hindi post (≈ 500 KB) is saved', long.status === 201, code(long));

  section('8. Ads');
  check('ads off at first: the site gets nothing to load', !data<{ on: boolean; client: string | null }>(await pub.get('/blog/ads')).on);
  check('a bad publisher id → 422', (await root.put('/admin/blog/ads', { adsOn: true, adClient: 'pub-123', slotList: '', slotArticle: '', reason: 'Start AdSense on the blog' })).status === 422);
  check('on without a publisher id → 422', (await root.put('/admin/blog/ads', { adsOn: true, adClient: '', slotList: '', slotArticle: '', reason: 'Start AdSense on the blog' })).status === 422);
  check('no reason → 422', (await root.put('/admin/blog/ads', { adsOn: true, adClient: 'ca-pub-1234567890123456', slotList: '', slotArticle: '' })).status === 422);
  check('a viewer cannot turn them on → 403', (await viewer.put('/admin/blog/ads', { adsOn: true, adClient: 'ca-pub-1234567890123456', slotList: '', slotArticle: '', reason: 'Start AdSense on the blog' })).status === 403);
  const on = await root.put('/admin/blog/ads', { adsOn: true, adClient: 'ca-pub-1234567890123456', slotList: '1234567890', slotArticle: '', reason: 'Start AdSense on the blog' });
  const ads = data<{ on: boolean; client: string; slotList: string | null; slotArticle: string | null }>(await pub.get('/blog/ads'));
  check('on: the site gets the publisher id and the list slot (article: Auto ads)', on.status === 200 && ads.on && ads.client === 'ca-pub-1234567890123456' && ads.slotList === '1234567890' && ads.slotArticle === null, code(on));

  section('9. Index for the sitemap and feed');
  const idx = data<{ posts: { lang: string; slug: string }[] }>(await pub.get('/blog/index'));
  check('every live post in every language, no drafts', idx.posts.length === 15 && !idx.posts.some((p) => p.slug === 'long-hindi'), String(idx.posts.length));

  section('10. Delete');
  const tipId = (await BlogPostModel.findOne({ slug: 'stock-tip-11' }).lean())?._id;
  check('no reason → 422', (await root.del(`/admin/blog/posts/${String(tipId)}`, {})).status === 422);
  check('a viewer cannot delete → 403', (await viewer.del(`/admin/blog/posts/${String(tipId)}`, { reason: 'Old tip, out of date' })).status === 403);
  // The English GST post's cover is shared by its Hindi translation, so it stays; its inline picture goes with both.
  await root.del(`/admin/blog/posts/${first.id}`, { reason: 'Rewriting it from scratch' });
  check('a picture another post still uses stays', await BlogImageModel.exists({ _id: cover.id }) !== null);
  const hiId = (await BlogPostModel.findOne({ lang: 'hi', slug: 'gst-on-medicines' }).lean())?._id;
  const gone = await root.del(`/admin/blog/posts/${String(hiId)}`, { reason: 'Rewriting it from scratch' });
  check('the last post using a picture takes it with it', gone.status === 200 && (await BlogImageModel.exists({ _id: cover.id })) === null && (await pub.raw('GET', `/blog/img/${cover.id}`)).status === 404, code(gone));
  check('the post is off the site', (await pub.get('/blog/posts/en/gst-on-medicines')).status === 404);
  const audit = await AdminAuditModel.find({ action: { $regex: /^blog_/ } }).lean();
  check('every write is in the admin audit log, with the reason for a delete', audit.some((a) => a.action === 'blog_post_removed' && a.reason === 'Rewriting it from scratch') && audit.some((a) => a.action === 'blog_ads') && audit.some((a) => a.action === 'blog_post_featured'));
  const longId = (await BlogPostModel.findOne({ slug: 'long-hindi' }).lean())?._id;
  check('a draft still holds the category → 409', (await root.del(`/admin/blog/categories/${gstId}`, { reason: 'No posts left in it' })).status === 409);
  await root.del(`/admin/blog/posts/${String(longId)}`, { reason: 'Draft no longer needed' });
  check('an empty category can be removed', (await root.del(`/admin/blog/categories/${gstId}`, { reason: 'No posts left in it' })).status === 200);

  finish();
}

main().catch(crash);
