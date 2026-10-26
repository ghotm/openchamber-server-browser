import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MARK_LIMIT,
  formatMarkClipboard,
  formatMarkLine,
  resolveMarkItems,
  sanitizeMarkPayload,
} from '../src/mark.js';

test('sanitizes a page payload into a bounded mark', () => {
  const mark = sanitizeMarkPayload({
    selector: '#save',
    tag: 'BUTTON',
    role: 'button',
    name: 'Save changes',
    text: 'Save   changes',
    attributes: { id: 'save', class: 'primary wide', secret: 42, long: 'x'.repeat(400) },
    rect: { x: 10.4, y: 20.6, width: 100.2, height: 30.9 },
    url: 'https://example.com/editor',
    title: 'Editor',
  }, { tabId: 'tab-1', url: 'https://fallback.test', title: 'Fallback' });

  assert.equal(typeof mark.id, 'string');
  assert.equal(mark.id.length, 36);
  assert.equal(mark.tabId, 'tab-1');
  assert.equal(mark.url, 'https://example.com/editor');
  assert.equal(mark.title, 'Editor');
  assert.equal(mark.selector, '#save');
  assert.equal(mark.tag, 'BUTTON');
  assert.equal(mark.text, 'Save changes');
  assert.deepEqual(mark.attributes, { id: 'save', class: 'primary wide' });
  assert.deepEqual(mark.rect, { x: 10, y: 21, width: 100, height: 31 });
  assert.equal(mark.resolved, true);
  assert.deepEqual(mark.shadowPath, []);
  assert.deepEqual(mark.frameSelectors, []);
});

test('keeps a multi-level shadow path', () => {
  const mark = sanitizeMarkPayload({
    selector: '',
    tag: 'BUTTON',
    shadowHostSelector: '#outer',
    shadowSelector: '#inner',
    shadowPath: ['#outer', '#middle', '#inner'],
  }, { tabId: 'tab-1' });

  assert.deepEqual(mark.shadowPath, ['#outer', '#middle', '#inner']);
  assert.equal(mark.shadowHostSelector, '#outer');
  assert.equal(mark.shadowSelector, '#inner');
  assert.equal(formatMarkLine(mark), '#outer >>> #middle >>> #inner');
});

test('keeps the frame chain for an element inside an iframe', () => {
  const mark = sanitizeMarkPayload({
    selector: '#inner',
    tag: 'TEXTAREA',
    frameSelectors: ['iframe#frame', 'iframe#nested'],
    frameUrl: 'https://example.com/frame',
    frameTitle: 'Frame',
  }, { tabId: 'tab-1' });

  assert.deepEqual(mark.frameSelectors, ['iframe#frame', 'iframe#nested']);
  assert.equal(mark.frameUrl, 'https://example.com/frame');
  assert.equal(mark.frameTitle, 'Frame');
  assert.equal(formatMarkLine(mark), 'iframe#frame >>> iframe#nested >>> #inner');
});

test('falls back to the tab url and title when the page omits them', () => {
  const mark = sanitizeMarkPayload({ tag: 'a', selector: 'a' }, { tabId: 'tab-1', url: 'https://fallback.test', title: 'Fallback' });
  assert.equal(mark.url, 'https://fallback.test');
  assert.equal(mark.title, 'Fallback');
});

test('rejects values that are not an object or have no tag', () => {
  assert.equal(sanitizeMarkPayload(null), null);
  assert.equal(sanitizeMarkPayload([], {}), null);
  assert.equal(sanitizeMarkPayload({ selector: '#save' }), null);
  assert.equal(sanitizeMarkPayload({ tag: '   ' }), null);
});

test('drops a rect with missing or non-finite numbers', () => {
  const mark = sanitizeMarkPayload({ tag: 'div', rect: { x: 1, y: 2, width: Number.NaN, height: 4 } });
  assert.equal(mark.rect, null);
});

test('formats a normal selector and a shadow path', () => {
  assert.equal(formatMarkLine({ selector: '#save', tag: 'button', name: 'Save changes' }), '#save "Save changes"');
  assert.equal(formatMarkLine({ tag: 'div', text: 'Hello' }), 'div "Hello"');
  assert.equal(formatMarkLine({
    selector: '',
    shadowHostSelector: '#panel',
    shadowSelector: 'button.save',
    tag: 'button',
  }), '#panel >>> button.save');
  assert.equal(formatMarkLine({
    selector: '',
    shadowPath: ['#outer', '#inner', 'button.save'],
    tag: 'button',
  }), '#outer >>> #inner >>> button.save');
});

test('formats a clipboard hint with a numbered list', () => {
  const marks = [
    { selector: '#save', tag: 'button', name: 'Save changes' },
    { selector: 'a.settings', tag: 'a', name: 'Settings' },
  ];
  const text = formatMarkClipboard(marks);
  assert.match(text, /I marked 2 elements in the shared browser/);
  assert.match(text, /browser\.snapshot/);
  assert.match(text, /1\. #save "Save changes"/);
  assert.match(text, /2\. a\.settings "Settings"/);
});

test('maps marks to the selectors the page will resolve', () => {
  const items = resolveMarkItems([
    { id: 'a', selector: '#save', shadowHostSelector: '', shadowSelector: '' },
    { id: 'b', selector: '', shadowHostSelector: '#panel', shadowSelector: 'button' },
    { id: 'c', selector: '#inner', shadowHostSelector: '', shadowSelector: '', frameSelectors: ['iframe#frame'] },
    { id: 'd', selector: '', shadowPath: ['#outer', '#inner', 'button'] },
  ]);
  assert.deepEqual(items, [
    { id: 'a', selector: '#save', shadowHostSelector: '', shadowSelector: '', shadowPath: [], frameSelectors: [] },
    { id: 'b', selector: '', shadowHostSelector: '#panel', shadowSelector: 'button', shadowPath: [], frameSelectors: [] },
    { id: 'c', selector: '#inner', shadowHostSelector: '', shadowSelector: '', shadowPath: [], frameSelectors: ['iframe#frame'] },
    { id: 'd', selector: '', shadowHostSelector: '', shadowSelector: '', shadowPath: ['#outer', '#inner', 'button'], frameSelectors: [] },
  ]);
});

test('keeps the per-tab mark cap explicit', () => {
  assert.equal(MARK_LIMIT, 50);
});
