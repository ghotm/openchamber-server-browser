const FRAME_LIMIT = 20;
const DEPTH_LIMIT = 8;

const cssEscape = (value) => String(value).replace(/[^a-zA-Z0-9_-]/g, (character) => `\\${character}`);

const attrMap = (attributes) => {
  const result = {};
  if (!Array.isArray(attributes)) return result;
  for (let index = 0; index + 1 < attributes.length; index += 2) {
    const name = attributes[index];
    const value = attributes[index + 1];
    if (typeof name === 'string' && typeof value === 'string') result[name] = value;
  }
  return result;
};

const nodeName = (node) => String(node?.localName || node?.nodeName || '').toLowerCase();

const isFrameNode = (node) => {
  const name = nodeName(node);
  return name === 'iframe' || name === 'frame';
};

const quadRect = (quad) => {
  if (!Array.isArray(quad) || quad.length < 8) return null;
  const xs = [quad[0], quad[2], quad[4], quad[6]];
  const ys = [quad[1], quad[3], quad[5], quad[7]];
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  const right = Math.max(...xs);
  const bottom = Math.max(...ys);
  return { x: left, y: top, width: right - left, height: bottom - top };
};

const elementChildren = (node) => {
  const children = Array.isArray(node?.children)
    ? node.children
    : Array.isArray(node?.childNodes)
      ? node.childNodes
      : [];
  return children.filter((child) => child?.nodeType === 1);
};

const frameTreeIndex = (frameTree) => {
  const frames = new Map();
  const visit = (node, parentId) => {
    const frame = node?.frame;
    if (!frame?.id) return;
    frames.set(frame.id, {
      id: frame.id,
      parentId: frame.parentId || parentId || null,
      url: frame.url || '',
      name: frame.name || '',
    });
    for (const child of node?.childFrames ?? []) visit(child, frame.id);
  };
  visit(frameTree, null);
  return frames;
};

export const createMarkCdp = ({
  cdp,
  sessionId,
  frameId,
  url = '',
  title = '',
}) => {
  const mainSession = sessionId;
  const mainFrame = frameId;
  const frameSessions = new Map([[mainFrame, mainSession]]);
  const frameContexts = new Map();
  const documents = new Map();
  const framePaths = new Map();
  const attached = new Set();
  let frames = null;
  let closed = false;

  const send = (session, method, params = {}) => cdp.sendSession(session, method, params);

  const describe = async (session, id, depth = 0, pierce = true, byBackend = false) => {
    const params = byBackend ? { backendNodeId: id } : { nodeId: id };
    const response = await send(session, 'DOM.describeNode', { ...params, depth, pierce });
    return response?.node ?? null;
  };

  const boxModel = async (session, nodeId) => {
    try {
      const response = await send(session, 'DOM.getBoxModel', { nodeId });
      return response?.model ?? null;
    } catch {
      return null;
    }
  };

  const boxModelFor = async (session, node) => {
    const params = node?.nodeId ? { nodeId: node.nodeId } : { backendNodeId: node?.backendNodeId };
    try {
      const response = await send(session, 'DOM.getBoxModel', params);
      return response?.model ?? null;
    } catch {
      return null;
    }
  };

  const loadFrames = async () => {
    if (frames) return frames;
    frames = new Map();
    try {
      const response = await send(mainSession, 'Page.getFrameTree');
      frames = frameTreeIndex(response?.frameTree);
    } catch {
      frames = new Map();
    }
    return frames;
  };

  const attachFrame = async (targetFrameId) => {
    if (!targetFrameId || targetFrameId === mainFrame) return mainSession;
    const cached = frameSessions.get(targetFrameId);
    if (cached) return cached;
    if (frameSessions.size >= FRAME_LIMIT) return null;
    let childSession;
    try {
      childSession = await cdp.attach(targetFrameId);
    } catch {
      return null;
    }
    attached.add(childSession);
    frameSessions.set(targetFrameId, childSession);
    await Promise.allSettled([
      send(childSession, 'Page.enable'),
      send(childSession, 'DOM.enable'),
      send(childSession, 'Runtime.enable'),
    ]);
    return childSession;
  };

  const contextFor = async (targetFrameId) => {
    if (!targetFrameId || targetFrameId === mainFrame) return null;
    const cached = frameContexts.get(targetFrameId);
    if (cached) return cached;
    try {
      const response = await send(mainSession, 'Page.createIsolatedWorld', {
        frameId: targetFrameId,
        worldName: 'openchamber-mark-hit',
      });
      const contextId = response?.executionContextId;
      if (Number.isInteger(contextId)) {
        frameContexts.set(targetFrameId, contextId);
        return contextId;
      }
    } catch {}
    return null;
  };

  const loadDocument = async (session) => {
    const response = await send(session, 'DOM.getDocument', { depth: -1, pierce: true });
    const root = response?.root;
    if (!root) throw new Error('Chrome returned no DOM document');
    const nodes = new Map();
    const visit = (node, parent, scope, shadowHost) => {
      if (!node) return;
      let rootScope = scope;
      let parentNode = parent;
      if (node.nodeType === 9) {
        rootScope = node;
        parentNode = null;
      }
      if (node.backendNodeId) {
        nodes.set(node.backendNodeId, {
          node,
          parent: parentNode,
          root: rootScope,
          host: shadowHost ?? null,
        });
      }
      for (const shadow of node.shadowRoots ?? []) visit(shadow, null, shadow, node);
      for (const child of node.children ?? []) visit(child, node, rootScope, shadowHost);
      if (node.contentDocument) visit(node.contentDocument, null, node.contentDocument, null);
    };
    visit(root, null, root, null);
    const document = { root, nodes };
    documents.set(session, document);
    return document;
  };

  const documentFor = async (session) => documents.get(session) ?? loadDocument(session);

  const entryFor = async (session, backendNodeId) => {
    let document = await documentFor(session);
    let entry = document.nodes.get(backendNodeId);
    if (!entry) {
      document = await loadDocument(session);
      entry = document.nodes.get(backendNodeId);
    }
    return entry ?? null;
  };

  const segmentFor = async (session, entry) => {
    const { node, parent, root } = entry;
    const attributes = attrMap(node.attributes);
    const tag = nodeName(node) || '*';
    if (attributes.id) {
      const selector = `#${cssEscape(attributes.id)}`;
      try {
        const matches = await send(session, 'DOM.querySelectorAll', { nodeId: root.nodeId, selector });
        if (Array.isArray(matches?.nodeIds) && matches.nodeIds.length === 1) return selector;
      } catch {}
    }
    let segment = tag;
    if (attributes.class) {
      const classes = attributes.class.trim().split(/\s+/).filter(Boolean).slice(0, 2);
      if (classes.length > 0) segment += `.${classes.map(cssEscape).join('.')}`;
    }
    const siblings = parent ? elementChildren(parent).filter((child) => child.nodeName === node.nodeName) : [];
    if (siblings.length > 1) segment += `:nth-of-type(${siblings.indexOf(node) + 1})`;
    return segment;
  };

  const selectorForNode = async (session, backendNodeId) => {
    let entry = await entryFor(session, backendNodeId);
    if (!entry) return { selector: '', shadowPath: [] };
    const segments = [];
    while (entry?.node?.nodeType === 1 && segments.length < DEPTH_LIMIT) {
      segments.unshift(await segmentFor(session, entry));
      if (entry.root?.nodeType === 9) break;
      if (entry.root?.nodeType === 11) {
        const host = entry.host;
        if (!host?.backendNodeId) break;
        entry = await entryFor(session, host.backendNodeId);
        continue;
      }
      break;
    }
    if (segments.length === 0) return { selector: '', shadowPath: [] };
    if (segments.length === 1) return { selector: segments[0], shadowPath: [] };
    return {
      selector: '',
      shadowPath: segments,
      shadowHostSelector: segments[0],
      shadowSelector: segments[segments.length - 1],
    };
  };

  const frameSelector = async (session, backendNodeId) => {
    const path = await selectorForNode(session, backendNodeId);
    return path.shadowPath.length > 0 ? path.shadowPath.join(' >>> ') : path.selector;
  };

  const findFrameOwner = async (parentSession, targetFrameId) => {
    try {
      const owner = await send(parentSession, 'DOM.getFrameOwner', { frameId: targetFrameId });
      if (Number.isInteger(owner?.backendNodeId)) return owner.backendNodeId;
    } catch {}
    try {
      const document = await documentFor(parentSession);
      for (const entry of document.nodes.values()) {
        if (!isFrameNode(entry.node)) continue;
        const described = await describe(parentSession, entry.node.backendNodeId, 0, true, true);
        if (described?.frameId === targetFrameId) return entry.node.backendNodeId;
      }
    } catch {}
    return null;
  };

  const framePath = async (targetFrameId) => {
    if (!targetFrameId || targetFrameId === mainFrame) return [];
    const cached = framePaths.get(targetFrameId);
    if (cached) return cached;
    const tree = await loadFrames();
    const frame = tree.get(targetFrameId);
    if (!frame) {
      framePaths.set(targetFrameId, []);
      return [];
    }
    const parentId = frame.parentId || mainFrame;
    // A same-process parent frame has no target of its own; the main session's
    // DOM tree still contains its document, so ownership can be read there.
    const parentSession = (await attachFrame(parentId)) ?? mainSession;
    const owner = await findFrameOwner(parentSession, targetFrameId);
    const selector = Number.isInteger(owner) ? await frameSelector(parentSession, owner) : '';
    if (!selector) {
      framePaths.set(targetFrameId, []);
      return [];
    }
    const parentPath = await framePath(parentId);
    const path = [...parentPath, selector];
    framePaths.set(targetFrameId, path);
    return path;
  };

  const queryPath = async (session, rootNodeId, segments) => {
    if (!Array.isArray(segments) || segments.length === 0) return null;
    let root = rootNodeId;
    let nodeId = null;
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      if (typeof segment !== 'string' || segment.length === 0) return null;
      try {
        const result = await send(session, 'DOM.querySelector', { nodeId: root, selector: segment });
        nodeId = result?.nodeId ?? null;
      } catch {
        return null;
      }
      if (!nodeId) return null;
      if (index < segments.length - 1) {
        const described = await describe(session, nodeId, 0);
        const shadow = described?.shadowRoots?.[0];
        if (!shadow?.nodeId) return null;
        root = shadow.nodeId;
      }
    }
    return nodeId;
  };

  const pathSegments = (value) => (typeof value === 'string' ? value.split(' >>> ').filter(Boolean) : []);

  const hitAt = async ({ x, y }) => {
    let session = mainSession;
    let px = x;
    let py = y;
    let offsetX = 0;
    let offsetY = 0;
    let selectors = [];
    for (let depth = 0; depth < DEPTH_LIMIT; depth += 1) {
      const location = await send(session, 'DOM.getNodeForLocation', {
        x: Math.round(px),
        y: Math.round(py),
        includeUserAgentShadowDOM: true,
      });
      if (!Number.isInteger(location?.backendNodeId)) return null;
      const node = await describe(
        session,
        location.nodeId ?? location.backendNodeId,
        0,
        true,
        !location.nodeId,
      );
      if (!node) return null;
      const hitFrameId = node.frameId ?? location.frameId;
      if (isFrameNode(node) && hitFrameId) {
        const path = await framePath(hitFrameId);
        const box = await boxModelFor(session, node);
        const content = quadRect(box?.content);
        const childSession = await attachFrame(hitFrameId);
        if (!childSession || childSession === session) {
          return {
            session,
            node,
            frameSelectors: [],
            offsetX,
            offsetY,
            frameId: hitFrameId,
          };
        }
        selectors = path.length > 0 ? path : [await frameSelector(session, node.backendNodeId)];
        if (content) {
          px -= content.x;
          py -= content.y;
          offsetX += content.x;
          offsetY += content.y;
        }
        session = childSession;
        continue;
      }
      if (hitFrameId && hitFrameId !== mainFrame) {
        const childSession = await attachFrame(hitFrameId);
        if (!childSession || childSession === session) {
          const ownerBackend = await findFrameOwner(session, hitFrameId);
          const ownerNode = ownerBackend ? { backendNodeId: ownerBackend } : null;
          const box = ownerNode ? await boxModelFor(session, ownerNode) : null;
          const content = quadRect(box?.content) ?? quadRect(box?.border);
          const contextId = await contextFor(hitFrameId);
          if (content && contextId !== null) {
            const evaluated = await send(session, 'Runtime.evaluate', {
              contextId,
              expression: `document.elementFromPoint(${Math.round(px - content.x)}, ${Math.round(py - content.y)})`,
              objectGroup: 'openchamber-mark',
            });
            const objectId = evaluated?.result?.objectId;
            if (objectId) {
              let inner = null;
              try {
                const described = await send(session, 'DOM.describeNode', {
                  objectId,
                  depth: 0,
                  pierce: true,
                });
                inner = described?.node ?? null;
              } catch {}
              if (inner) {
                return {
                  session,
                  node: inner,
                  frameSelectors: await framePath(hitFrameId),
                  offsetX,
                  offsetY,
                  frameId: hitFrameId,
                };
              }
            }
          }
        }
      }
      if (selectors.length === 0 && hitFrameId && hitFrameId !== mainFrame) {
        selectors = await framePath(hitFrameId);
      }
      return { session, node, frameSelectors: selectors, offsetX, offsetY, frameId: hitFrameId ?? mainFrame };
    }
    return null;
  };

  const elementInfo = async (session, backendNodeId) => {
    const resolved = await send(session, 'DOM.resolveNode', { backendNodeId });
    const objectId = resolved?.object?.objectId;
    if (!objectId) return {};
    try {
      const response = await send(session, 'Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: `function () {
          const el = this;
          const readText = (value) => String(value ?? '').replace(/\\s+/g, ' ').trim();
          const attributes = {};
          for (const name of ['id', 'class', 'name', 'type', 'role', 'href', 'src', 'alt', 'title', 'placeholder', 'aria-label', 'aria-labelledby', 'data-testid']) {
            const value = el.getAttribute(name);
            if (value) attributes[name] = value;
          }
          const text = readText(el.innerText ?? el.textContent).slice(0, 500);
          const labelledBy = el.getAttribute('aria-labelledby');
          let name = el.getAttribute('aria-label') || '';
          if (!name && labelledBy) {
            name = labelledBy.split(/\\s+/).map((id) => {
              try { return el.ownerDocument.getElementById(id)?.textContent ?? ''; } catch { return ''; }
            }).join(' ');
          }
          if (!name && el.labels && el.labels.length > 0) {
            name = Array.from(el.labels, (item) => item.textContent ?? '').join(' ');
          }
          if (!name && el.tagName === 'IMG') name = el.getAttribute('alt') ?? '';
          if (!name) name = el.getAttribute('title') ?? text;
          let frameUrl = '';
          let frameTitle = '';
          try {
            frameUrl = el.ownerDocument.location?.href ?? '';
            frameTitle = el.ownerDocument.title ?? '';
          } catch {}
          return {
            tag: el.tagName.toLowerCase(),
            role: el.getAttribute('role') || '',
            name: readText(name).slice(0, 300),
            text,
            attributes,
            frameUrl,
            frameTitle,
          };
        }`,
        returnByValue: true,
      });
      return response?.result?.value ?? {};
    } catch {
      return {};
    }
  };

  const describeHit = async (hit) => {
    const path = await selectorForNode(hit.session, hit.node.backendNodeId);
    const info = await elementInfo(hit.session, hit.node.backendNodeId);
    const frameSelectors = Array.isArray(hit.frameSelectors) && hit.frameSelectors.length > 0
      ? hit.frameSelectors
      : hit.frameId && hit.frameId !== mainFrame
        ? await framePath(hit.frameId)
        : [];
    let rect = null;
    const box = await boxModelFor(hit.session, hit.node);
    const quad = quadRect(box?.border) ?? quadRect(box?.content);
    if (quad) {
      rect = {
        x: quad.x + (hit.session === mainSession ? 0 : hit.offsetX),
        y: quad.y + (hit.session === mainSession ? 0 : hit.offsetY),
        width: quad.width,
        height: quad.height,
      };
    }
    return {
      selector: path.selector ?? '',
      shadowHostSelector: path.shadowHostSelector ?? '',
      shadowSelector: path.shadowSelector ?? '',
      shadowPath: Array.isArray(path.shadowPath) ? path.shadowPath : [],
      frameSelectors,
      frameUrl: frameSelectors.length > 0 ? info.frameUrl ?? '' : '',
      frameTitle: frameSelectors.length > 0 ? info.frameTitle ?? '' : '',
      tag: info.tag || nodeName(hit.node),
      role: info.role ?? '',
      name: info.name ?? '',
      text: info.text ?? '',
      attributes: info.attributes ?? {},
      rect,
      url,
      title,
    };
  };

  const hoverAt = async ({ x, y }) => {
    const hit = await hitAt({ x, y });
    if (!hit) return null;
    const box = await boxModelFor(hit.session, hit.node);
    const quad = quadRect(box?.border) ?? quadRect(box?.content);
    if (!quad) return null;
    const attributes = attrMap(hit.node.attributes);
    const tag = nodeName(hit.node) || 'element';
    const identifier = attributes.id ? `#${attributes.id}` : '';
    const classes = attributes.class
      ? `.${attributes.class.trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.')}`
      : '';
    return {
      rect: {
        x: quad.x + (hit.session === mainSession ? 0 : hit.offsetX),
        y: quad.y + (hit.session === mainSession ? 0 : hit.offsetY),
        width: quad.width,
        height: quad.height,
      },
      label: `${tag}${identifier}${classes}`,
    };
  };

  const resolveOne = async (item) => {
    let session = mainSession;
    let root = (await documentFor(mainSession)).root.nodeId;
    let offsetX = 0;
    let offsetY = 0;
    for (const selector of Array.isArray(item.frameSelectors) ? item.frameSelectors : []) {
      const frameNodeId = await queryPath(session, root, pathSegments(selector));
      if (!frameNodeId) return { id: item.id, status: 'missing' };
      const described = await describe(session, frameNodeId, 1);
      const frameId = described?.frameId;
      const box = await boxModel(session, frameNodeId);
      const content = quadRect(box?.content);
      const childSession = frameId ? await attachFrame(frameId) : null;
      if (childSession) {
        session = childSession;
        root = (await documentFor(childSession)).root.nodeId;
        if (content) {
          offsetX += content.x;
          offsetY += content.y;
        }
      } else {
        const contentDocument = described?.contentDocument?.nodeId;
        if (!contentDocument) return { id: item.id, status: 'missing' };
        root = contentDocument;
      }
    }
    const segments = Array.isArray(item.shadowPath) && item.shadowPath.length > 0
      ? item.shadowPath
      : item.shadowHostSelector && item.shadowSelector
        ? [item.shadowHostSelector, item.shadowSelector]
        : item.selector
          ? [item.selector]
          : [];
    const nodeId = await queryPath(session, root, segments);
    if (!nodeId) return { id: item.id, status: 'missing' };
    let rect = null;
    const box = await boxModel(session, nodeId);
    const quad = quadRect(box?.border) ?? quadRect(box?.content);
    if (quad) {
      rect = {
        x: quad.x + (session === mainSession ? 0 : offsetX),
        y: quad.y + (session === mainSession ? 0 : offsetY),
        width: quad.width,
        height: quad.height,
      };
    }
    return { id: item.id, status: 'found', rect };
  };

  return {
    describeAt: async (point) => {
      const hit = await hitAt(point);
      return hit ? describeHit(hit) : null;
    },
    hoverAt,
    resolve: async (items) => {
      const results = [];
      for (const item of Array.isArray(items) ? items : []) {
        try {
          results.push(await resolveOne(item));
        } catch {
          results.push({ id: item?.id, status: 'error' });
        }
      }
      return results;
    },
    close: async () => {
      if (closed) return;
      closed = true;
      await Promise.allSettled([...attached].map((childSession) => (
        cdp.send('Target.detachFromTarget', { sessionId: childSession })
      )));
      attached.clear();
    },
  };
};
