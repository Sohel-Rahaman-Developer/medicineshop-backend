import { Schema, model, type InferSchemaType, type Types } from 'mongoose';

export const BLOG_LANGS = ['en', 'hi', 'bn'] as const;
export type BlogLang = (typeof BLOG_LANGS)[number];
export const POST_STATUS = ['draft', 'published'] as const;

// D115: the public blog — platform content, not a shop's, so no tenant scope. A translation shares the slug.
const postSchema = new Schema(
  {
    slug: { type: String, required: true },
    lang: { type: String, enum: BLOG_LANGS, required: true },
    title: { type: String, required: true },
    description: { type: String, required: true },
    /** The editor's document, already cleaned (cleanDoc). */
    content: { type: Schema.Types.Mixed, required: true },
    /** Plain words, for search, the read time and the related posts. */
    text: { type: String, default: '' },
    categoryId: { type: Schema.Types.ObjectId, default: null },
    coverId: { type: Schema.Types.ObjectId, default: null },
    coverAlt: { type: String, default: '' },
    tags: { type: [String], default: [] },
    author: { type: String, default: 'MedBox24 team' },
    featured: { type: Boolean, default: false },
    status: { type: String, enum: POST_STATUS, default: 'draft' },
    /** A future time keeps a published post off the site until then. */
    publishedAt: { type: Date, default: null },
    words: { type: Number, default: 0 },
    createdBy: { type: String, required: true },
    updatedBy: { type: String, required: true },
  },
  { timestamps: true, versionKey: false },
);
postSchema.index({ lang: 1, slug: 1 }, { unique: true });
postSchema.index({ status: 1, lang: 1, publishedAt: -1 });

export type BlogPost = InferSchemaType<typeof postSchema> & { _id: Types.ObjectId; createdAt: Date; updatedAt: Date };
export const BlogPostModel = model('BlogPost', postSchema);

/** A topic the posts sit under, named in each site language (English when one is left empty). */
const categorySchema = new Schema(
  {
    slug: { type: String, required: true, unique: true },
    names: { type: new Schema({ en: { type: String, required: true }, hi: { type: String, default: '' }, bn: { type: String, default: '' } }, { _id: false }), required: true },
    order: { type: Number, default: 0 },
  },
  { timestamps: true, versionKey: false },
);
export type BlogCategory = InferSchemaType<typeof categorySchema> & { _id: Types.ObjectId };
export const BlogCategoryModel = model('BlogCategory', categorySchema);

/** A picture for a post, kept as WebP; its id never changes, so it is cached for a year. */
const imageSchema = new Schema(
  {
    data: { type: Buffer, required: true },
    width: { type: Number, required: true },
    height: { type: Number, required: true },
    createdBy: { type: String, required: true },
  },
  { timestamps: true, versionKey: false },
);
export const BlogImageModel = model('BlogImage', imageSchema);

/** Google AdSense on blog pages only: the publisher id and optional unit slots (none = Auto ads). */
const settingSchema = new Schema(
  {
    _id: { type: String, default: 'blog' },
    adsOn: { type: Boolean, default: false },
    adClient: { type: String, default: '' },
    slotList: { type: String, default: '' },
    slotArticle: { type: String, default: '' },
    updatedBy: { type: String, default: '' },
  },
  { timestamps: true, versionKey: false },
);
export const BlogSettingModel = model('BlogSetting', settingSchema);
