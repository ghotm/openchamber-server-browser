import crypto from 'node:crypto';

export const MARK_WORLD = 'openchamber-mark';
export const MARK_LIMIT = 50;

const MAX_SELECTOR = 2_000;
const MAX_TAG = 60;
const MAX_NAME = 300;
const MAX_TEXT = 500;
const MAX_ATTRIBUTE_NAME = 60;
const MAX_ATTRIBUTE_VALUE = 240;
const MAX_ATTRIBUTES = 20;
const ATTRIBUTE_NAMES = new Set([
  'id', 'class', 'name', 'type', 'role', 'href', 'src', 'alt', 'title', 'placeholder',
  'aria-label', 'aria-labelledby', 'data-testid',
]);

const clean = (value, maximum) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maximum);

const finite = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

const cleanRect = (rect) => {
  if (!rect || typeof rect !== 'object') return null;
  const x = finite(rect.x);
  const y = finite(rect.y);
  const width = finite(rect.width);
  const height = finite(rect.height);
  if (x === null || y === null || width === null || height === null) return null;
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.max(0, Math.round(width)),
    height: Math.max(0, Math.round(height)),
  };
};

const cleanAttributes = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const attributes = {};
  for (const [name, entry] of Object.entries(value)) {
    if (Object.keys(attributes).length >= MAX_ATTRIBUTES) break;
    if (typeof name !== 'string' || name.length === 0 || name.length > MAX_ATTRIBUTE_NAME) continue;
    if (!ATTRIBUTE_NAMES.has(name)) continue;
    if (typeof entry !== 'string' || entry.length === 0) continue;
    attributes[name] = entry.slice(0, MAX_ATTRIBUTE_VALUE);
  }
  return attributes;
};

const cleanFrameSelectors = (value) => (Array.isArray(value) ? value : [])
  .filter((entry) => typeof entry === 'string')
  .map((entry) => clean(entry, MAX_SELECTOR))
  .filter(Boolean)
  .slice(0, 8);

const cleanShadowPath = (value) => (Array.isArray(value) ? value : [])
  .filter((entry) => typeof entry === 'string')
  .map((entry) => clean(entry, MAX_SELECTOR))
  .filter(Boolean)
  .slice(0, 8);

// The page returns only strings and numbers; everything else is dropped here so
// a page cannot put objects, huge arrays, or prototype tricks into service state.
export const sanitizeMarkPayload = (payload, { tabId, url = '', title = '' } = {}) => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const tag = clean(payload.tag, MAX_TAG);
  if (!tag) return null;
  return {
    id: crypto.randomUUID(),
    tabId: typeof tabId === 'string' ? tabId : '',
    url: clean(payload.url, MAX_SELECTOR) || clean(url, MAX_SELECTOR),
    title: clean(payload.title, MAX_NAME) || clean(title, MAX_NAME),
    selector: clean(payload.selector, MAX_SELECTOR),
    shadowHostSelector: clean(payload.shadowHostSelector, MAX_SELECTOR),
    shadowSelector: clean(payload.shadowSelector, MAX_SELECTOR),
    shadowPath: cleanShadowPath(payload.shadowPath),
    frameSelectors: cleanFrameSelectors(payload.frameSelectors),
    frameUrl: clean(payload.frameUrl, MAX_SELECTOR),
    frameTitle: clean(payload.frameTitle, MAX_NAME),
    tag,
    role: clean(payload.role, MAX_NAME),
    name: clean(payload.name, MAX_NAME),
    text: clean(payload.text, MAX_TEXT),
    attributes: cleanAttributes(payload.attributes),
    rect: cleanRect(payload.rect),
    createdAt: Date.now(),
    resolved: true,
  };
};

export const resolveMarkItems = (marks) => marks.map((mark) => ({
  id: mark.id,
  selector: mark.selector ?? '',
  shadowHostSelector: mark.shadowHostSelector ?? '',
  shadowSelector: mark.shadowSelector ?? '',
  shadowPath: Array.isArray(mark.shadowPath) ? [...mark.shadowPath] : [],
  frameSelectors: Array.isArray(mark.frameSelectors) ? [...mark.frameSelectors] : [],
}));

export const formatMarkLine = (mark) => {
  const shadowPath = Array.isArray(mark.shadowPath) ? mark.shadowPath : [];
  const target = shadowPath.length > 0
    ? shadowPath.join(' >>> ')
    : mark.shadowHostSelector && mark.shadowSelector
      ? `${mark.shadowHostSelector} >>> ${mark.shadowSelector}`
      : mark.selector || mark.tag;
  const frames = Array.isArray(mark.frameSelectors) ? mark.frameSelectors : [];
  const path = frames.length > 0 ? `${frames.join(' >>> ')} >>> ${target}` : target;
  const label = mark.name || mark.text;
  return label ? `${path} "${label}"` : path;
};

export const formatMarkClipboard = (marks) => {
  const count = marks.length;
  const header = `I marked ${count} element${count === 1 ? '' : 's'} in the shared browser. Call openchamber_web browser.snapshot and read the marks list.`;
  return [header, '', ...marks.map((mark, index) => `${index + 1}. ${formatMarkLine(mark)}`)].join('\n');
};

// Runs in the page's isolated world. It is serialized by Function#toString, so
// it must not reference anything outside its own body.
function installMarkOverlay() {
  const state = (globalThis.__openchamberMark ??= {});
  state.cancel?.();

  const host = document.createElement('openchamber-mark');
  host.setAttribute('style', 'all: initial; position: fixed; inset: 0; z-index: 2147483647; display: block; pointer-events: none;');
  const root = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = [
    '.box { position: fixed; box-sizing: border-box; border: 2px solid #4f8cff; border-radius: 3px;'
      + ' background: rgba(79, 140, 255, .14); pointer-events: none; }',
    '.label { position: fixed; max-width: 340px; padding: 3px 6px; overflow: hidden; border-radius: 4px;'
      + ' background: #111827; color: #f9fafb; font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;'
      + ' text-overflow: ellipsis; white-space: nowrap; pointer-events: none; }',
  ].join('\n');
  const box = document.createElement('div');
  box.className = 'box';
  box.hidden = true;
  const label = document.createElement('div');
  label.className = 'label';
  label.hidden = true;
  root.append(style, box, label);
  document.documentElement.append(host);

  const hide = () => {
    box.hidden = true;
    label.hidden = true;
  };

  const place = (left, top, width, height, text) => {
    box.hidden = false;
    box.style.left = `${left}px`;
    box.style.top = `${top}px`;
    box.style.width = `${width}px`;
    box.style.height = `${height}px`;
    label.textContent = text;
    label.hidden = false;
    const labelWidth = label.getBoundingClientRect().width;
    label.style.left = `${Math.max(4, Math.min(left, innerWidth - labelWidth - 4))}px`;
    label.style.top = `${top > 24 ? top - 22 : top + height + 4}px`;
  };

  const onViewportChange = () => hide();
  addEventListener('scroll', onViewportChange, true);
  addEventListener('resize', onViewportChange, true);

  state.setHighlight = (highlight) => {
    const rect = highlight?.rect;
    if (!rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) {
      hide();
      return;
    }
    place(rect.x, rect.y, rect.width, rect.height, String(highlight.label ?? 'element'));
  };
  state.clearHighlight = hide;
  state.cancel = () => {
    removeEventListener('scroll', onViewportChange, true);
    removeEventListener('resize', onViewportChange, true);
    host.remove();
    box.hidden = true;
    label.hidden = true;
    state.cancel = null;
    state.setHighlight = null;
    state.clearHighlight = null;
  };
  return { ok: true };
}

function callMarkOverlay({ method, argument }) {
  const state = globalThis.__openchamberMark;
  if (!state || typeof state[method] !== 'function') return null;
  return state[method](argument);
}

const call = (page, contextId, fn, argument) => page.cdp.sendSession(page.sessionId, 'Runtime.callFunctionOn', {
  functionDeclaration: fn.toString(),
  executionContextId: contextId,
  arguments: argument === undefined ? [] : [{ value: argument }],
  returnByValue: true,
  awaitPromise: true,
});

export const installMark = async (page, contextId) => {
  await call(page, contextId, installMarkOverlay);
};

export const setMarkHighlight = async (page, contextId, highlight) => {
  await call(page, contextId, callMarkOverlay, { method: 'setHighlight', argument: highlight });
};

export const clearMarkHighlight = async (page, contextId) => {
  await call(page, contextId, callMarkOverlay, { method: 'clearHighlight' }).catch(() => {});
};

export const cancelMark = async (page, contextId) => {
  await call(page, contextId, callMarkOverlay, { method: 'cancel' }).catch(() => {});
};
