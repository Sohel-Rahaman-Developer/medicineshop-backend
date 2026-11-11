import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanDoc, mediaIds, plainText, safeHref, sizeImages, wordCount, type DocNode } from '../../src/modules/blog/blog.doc';

const p = (...content: unknown[]) => ({ type: 'paragraph', content });
const t = (text: string, marks?: unknown[]) => ({ type: 'text', text, ...(marks ? { marks } : {}) });
const ID = 'a'.repeat(24);

void test('D115: only the blocks the blog shows are kept; anything else is dropped', () => {
  const doc = cleanDoc({ type: 'doc', content: [{ type: 'heading', attrs: { level: 1, style: 'x' }, content: [t('Title')] }, { type: 'script', content: [t('alert(1)')] }, { type: 'iframe', attrs: { src: 'https://evil.test' } }, p(t('Hello', [{ type: 'bold' }, { type: 'textStyle', attrs: { color: 'red' } }]))] });
  assert.deepEqual(doc, { type: 'doc', content: [{ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Title' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'Hello', marks: [{ type: 'bold' }] }] }] }, 'h1 becomes h2 (the page has its own h1); unknown marks and attrs go');
});

void test('D115: links keep the web, mail, phone and own paths; javascript: and data: are dropped', () => {
  assert.equal(safeHref('javascript:alert(1)'), null);
  assert.equal(safeHref(' JavaScript:alert(1)'), null);
  assert.equal(safeHref('data:text/html,<b>x</b>'), null);
  assert.equal(safeHref('//evil.test/x'), null, 'a protocol-relative link is another site in disguise');
  assert.equal(safeHref('/pricing'), '/pricing');
  assert.equal(safeHref('https://medbox24.in/#pricing'), 'https://medbox24.in/#pricing');
  assert.equal(safeHref('mailto:support@medbox24.in'), 'mailto:support@medbox24.in');
  const doc = cleanDoc({ type: 'doc', content: [p(t('bad', [{ type: 'link', attrs: { href: 'javascript:alert(1)', onclick: 'x' } }]), t('good', [{ type: 'link', attrs: { href: '/guides', target: '_self' } }]))] });
  assert.deepEqual(doc.content?.[0]?.content, [{ type: 'text', text: 'bad' }, { type: 'text', text: 'good', marks: [{ type: 'link', attrs: { href: '/guides' } }] }]);
});

void test('D115: pictures are our own (media:<id>) or https; their size is filled from the store', () => {
  const doc = cleanDoc({ type: 'doc', content: [{ type: 'image', attrs: { src: `media:${ID}`, alt: 'Counter', onerror: 'x' } }, { type: 'image', attrs: { src: 'http://plain.test/a.png' } }, { type: 'image', attrs: { src: 'javascript:1' } }] });
  assert.equal(doc.content?.length, 1);
  assert.deepEqual([...mediaIds(doc)], [ID]);
  const sized = sizeImages(doc, new Map([[ID, { width: 1200, height: 630 }]]));
  assert.deepEqual(sized.content?.[0]?.attrs, { src: `media:${ID}`, alt: 'Counter', title: '', width: 1200, height: 630 });
});

void test('D115: words for the read time, tables and lists counted, nesting and size have limits', () => {
  const doc = cleanDoc({ type: 'doc', content: [p(t('GST on medicines')), { type: 'bulletList', content: [{ type: 'listItem', content: [p(t('five per cent'))] }] }, { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', attrs: { colspan: 99 }, content: [p(t('HSN 3004'))] }] }] }] });
  const text = plainText(doc).replace(/\s+/g, ' ').trim();
  assert.equal(text, 'GST on medicines five per cent HSN 3004');
  assert.equal(wordCount(text), 8);
  assert.equal(doc.content?.[2]?.content?.[0]?.content?.[0]?.attrs?.colspan, 1, 'a silly colspan falls back to 1');
  let deep: unknown = t('deep');
  for (let i = 0; i < 20; i += 1) deep = { type: 'blockquote', content: [deep] };
  const nested = cleanDoc({ type: 'doc', content: [deep] });
  assert.ok(!JSON.stringify(nested).includes('deep'), 'too deep is cut off');
  const huge = cleanDoc({ type: 'doc', content: Array.from({ length: 30 }, () => p(t('x'.repeat(10_000)))) });
  assert.ok(plainText(huge).replace(/\s/g, '').length <= 200_000, 'text has a ceiling');
  assert.deepEqual(cleanDoc(null), { type: 'doc', content: [] } satisfies DocNode);
});
