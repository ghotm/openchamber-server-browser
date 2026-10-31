import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createBrowserManager } from '../src/browser-manager.js';
import { createBrowserRuntime } from '../src/browser-runtime.js';
import { createChromeProcess, resolveChromePath } from '../src/chrome-process.js';

const modifiers = Object.freeze({ alt: false, ctrl: false, meta: false, shift: false });

const lstatExists = (file) => {
  try {
    fs.lstatSync(file);
    return true;
  } catch {
    return false;
  }
};

const listen = (server) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});

const close = (server) => new Promise((resolve) => server.close(resolve));

const waitFor = async (predicate, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the condition');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

const html = (body, title) => `<!doctype html>
<html><head><title>${title}</title><style>
body { margin: 0; font-family: sans-serif; min-height: 2400px; }
#surface { position: absolute; left: 10px; top: 10px; width: 130px; height: 44px; }
#name { position: absolute; left: 10px; top: 70px; }
#mark { position: absolute; left: 10px; top: 120px; }
#output { position: absolute; left: 10px; top: 180px; }
#hash { position: absolute; left: 10px; top: 230px; }
</style></head><body>${body}</body></html>`;

const startWebFixture = async ({ frameOrigin = '' } = {}) => {
  const server = http.createServer((request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    if (request.url === '/selects') {
      response.setHeader('content-security-policy', "default-src 'self'; style-src 'none'; script-src 'unsafe-inline'");
      response.end(html(`
        <input id="name" aria-label="Name" value="initial">
        <select id="native"><option>One</option><option>Two</option></select>
        <select id="listbox" size="2"><option>One</option><option>Two</option></select>
        <button id="custom" role="combobox">Custom menu</button>
        <select id="rich">
          <option value="a" label="Alpha explicit">Ignored text</option>
          <option value="b">Beta</option>
          <option value="c" disabled>Gamma</option>
          <optgroup label="Group" disabled><option value="d">Delta</option></optgroup>
        </select>
        <select id="multi" multiple><option value="x">X</option><option value="y">Y</option></select>
        <select id="dupes">
          <option value="1" label="Same">One</option>
          <option value="2" label="Same">Two</option>
        </select>
        <select id="empty-label"><option value="e" label="">Empty label</option></select>
        <select id="disabled-select" disabled><option value="f">Foo</option></select>
        <select id="evented"><option value="one">One</option><option value="two">Two</option></select>
        <script>
          window.selectEvents = { input: 0, change: 0 };
          const evented = document.querySelector('#evented');
          evented.addEventListener('input', () => { window.selectEvents.input += 1; });
          evented.addEventListener('change', () => { window.selectEvents.change += 1; });
        </script>
      `, 'Select compatibility'));
      return;
    }
    if (request.url === '/form') {
      response.end(html(`
        <section id="dialog"><p>Inside the dialog</p>
          <select id="country" aria-label="Country">
            <option value="">Choose</option>
            <option value="ca">  Canada
              (CA) </option>
            <option value="us" label="United States">US</option>
            <option value="mx" disabled>Mexico</option>
            <optgroup label="Closed" disabled><option value="xx">Nowhere</option></optgroup>
            <option value="t1">Twin</option>
            <option value="t2">Twin</option>
          </select>
        </section>
        <p>Outside the dialog</p>
        <select id="many" multiple><option>A</option></select>
        <select id="long"></select>
        <button id="custom" role="combobox">Custom</button>
        <script>
          window.changes = 0;
          document.querySelector('#country').addEventListener('change', () => { window.changes += 1; });
          const long = document.querySelector('#long');
          for (let i = 0; i < 40; i += 1) long.add(new Option(i === 0 ? 'x'.repeat(100) : 'Option ' + i, String(i)));
        </script>
      `, 'Form'));
      return;
    }
    if (request.url === '/splash') {
      response.end(html(`
        <h1 id="status">Loading splash</h1>
        <script>
          addEventListener('load', () => setTimeout(() => fetch('/api/chunk').then(() => {
            document.querySelector('#status').textContent = 'App ready';
          }), 300));
        </script>
      `, 'Splash'));
      return;
    }
    if (request.url === '/busy') {
      response.end(html(`
        <output id="ticks">0</output>
        <script>setInterval(() => { const t = document.querySelector('#ticks'); t.textContent = String(Number(t.textContent) + 1); }, 100);</script>
      `, 'Busy'));
      return;
    }
    if (request.url === '/next') {
      response.end(html('<h1>Next page</h1><a href="/">Home</a>', 'Next'));
      return;
    }
    if (request.url.startsWith('/api')) {
      request.resume();
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ token: 'abc', ok: true }));
      return;
    }
    if (request.url === '/inspect') {
      response.end(html(`
        <button id="surface" onclick="console.error('boom from page'); fetch('/api?token=secret', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'hunter2', name: 'ada' }) })">Run</button>
      `, 'Inspect'));
      return;
    }
    if (request.url === '/menu') {
      response.end(html(`
        <div id="surface">Plain area</div>
        <div id="custom" style="position:absolute;left:10px;top:300px;width:130px;height:44px">Custom</div>
        <p id="words" style="position:absolute;left:10px;top:400px">Copy these words</p>
        <script>
          window.clicks = 0;
          window.escapes = 0;
          addEventListener('click', () => { window.clicks += 1; });
          addEventListener('keydown', (event) => { if (event.key === 'Escape') window.escapes += 1; });
          document.querySelector('#custom').addEventListener('contextmenu', (event) => {
            event.preventDefault();
            document.title = 'Custom menu';
          });
        </script>
      `, 'Menu'));
      return;
    }
    if (request.url === '/tabs') {
      response.end(html(`
        <a id="surface" href="/next" target="_blank">Open next</a>
        <button id="mark" onclick="window.open('/next', 'popup')">Open popup</button>
      `, 'Tabs'));
      return;
    }
    if (request.url === '/headers') {
      const sent = { userAgent: request.headers['user-agent'], hints: request.headers['sec-ch-ua'] ?? null };
      response.end(html(`<pre id="headers">${JSON.stringify(sent)}</pre>`, 'Headers'));
      return;
    }
    if (request.url === '/title') {
      response.end(html('<button id="surface" onclick="document.title = \'Renamed by the page\'">Rename</button>', 'Title before'));
      return;
    }
    if (request.url === '/slow') {
      response.write('<!doctype html><title>Slow</title><p>Still loading');
      const timer = setTimeout(() => response.end('</p>'), 10_000);
      response.once('close', () => clearTimeout(timer));
      return;
    }
    if (request.url === '/hang') {
      response.end(html('<button id="hang" onclick="for (;;) {}">Hang</button>', 'Hang'));
      return;
    }
    if (request.url === '/copy') {
      response.end(html(`
        <input id="secret" type="password" value="hunter2">
        <div id="host"></div>
        <iframe id="frame" srcdoc="<textarea id='inner'>frame text</textarea>"></iframe>
        <script>
          document.querySelector('#host').attachShadow({ mode: 'open' }).innerHTML = '<input id="shadowed" value="shadow text">';
        </script>
      `, 'Copy'));
      return;
    }
    if (request.url === '/shadow') {
      response.end(html(`
        <div id="closed-host" style="position:absolute;left:20px;top:20px;width:200px;height:60px"></div>
        <div id="outer-host" style="position:absolute;left:20px;top:120px;width:220px;height:70px"></div>
        <script>
          const closed = document.querySelector('#closed-host').attachShadow({ mode: 'closed' });
          closed.innerHTML = '<button id="closed-btn" style="position:absolute;left:10px;top:10px;width:120px;height:40px">Closed</button>';
          const outer = document.querySelector('#outer-host').attachShadow({ mode: 'open' });
          outer.innerHTML = '<div id="inner-host" style="position:absolute;left:10px;top:10px;width:180px;height:50px"></div>';
          const inner = outer.querySelector('#inner-host').attachShadow({ mode: 'open' });
          inner.innerHTML = '<button id="nested-btn" style="position:absolute;left:10px;top:10px;width:140px;height:30px">Nested</button>';
        </script>
      `, 'Shadow'));
      return;
    }
    if (request.url === '/cross') {
      response.end(html(`
        <iframe id="cross" src="${frameOrigin}/cross-inner" style="position:absolute;left:10px;top:10px;width:300px;height:120px;border:0"></iframe>
      `, 'Cross'));
      return;
    }
    if (request.url === '/cross-inner') {
      response.end(html('<button id="cross-btn" style="position:absolute;left:20px;top:20px;width:120px;height:40px">Cross</button>', 'Cross inner'));
      return;
    }
    if (request.url === '/keys') {
      response.end(html(`
        <textarea id="notes"></textarea>
        <form id="form"><input id="field" value="hello world"></form>
        <output id="submits">0</output>
        <script>
          document.querySelector('#form').addEventListener('submit', (event) => {
            event.preventDefault();
            const submits = document.querySelector('#submits');
            submits.textContent = String(Number(submits.textContent) + 1);
          });
        </script>
      `, 'Keys'));
      return;
    }
    response.end(html(`
      <button id="surface" onclick="this.textContent='Surface clicked'">Surface</button>
      <input id="name" aria-label="Name" value="initial">
      <button id="mark" onclick="document.querySelector('#output').textContent=document.querySelector('#name').value">Mark</button>
      <div id="output">Waiting</div>
      <a id="hash" href="#section">Section</a>
      <h1 id="section" style="margin-top:320px">Browser fixture</h1>
    `, 'Fixture'));
  });
  const port = await listen(server);
  return { server, origin: `http://127.0.0.1:${port}` };
};

let chromePath = null;
try {
  chromePath = resolveChromePath();
} catch {}

test('runs every browser action and the shared surface against real Chrome', { skip: chromePath ? false : 'Chrome is unavailable' }, async (context) => {
  const web = await startWebFixture();
  context.after(() => close(web.server));
  const runtime = createBrowserRuntime({ chromePath, allowedOrigins: [web.origin] });
  context.after(() => runtime.close());

  const opened = await runtime.perform('browser.open', { url: `${web.origin}/`, viewport: 'desktop' });
  const initial = await runtime.perform('browser.snapshot', {});
  const inspected = await runtime.perform('browser.inspect', { selector: '#name' });
  await runtime.perform('browser.type', { selector: '#name', value: 'Ada', submit: false });
  await runtime.perform('browser.click', { selector: '#mark' });
  const marked = await runtime.perform('browser.snapshot', {});
  const scrolled = await runtime.perform('browser.scroll', { direction: 'bottom' });
  const capture = await runtime.perform('browser.capture', { label: 'fixture' });
  const resized = await runtime.perform('browser.resize', { viewport: 'mobile' });
  await runtime.perform('browser.open', { url: `${web.origin}/next`, tabId: opened.tabId });
  const back = await runtime.perform('browser.back', {});
  const forward = await runtime.perform('browser.forward', {});

  assert.equal(opened.opened, true);
  assert.equal(opened.url, `${web.origin}/`);
  assert.match(initial.text, /Browser fixture/);
  assert.equal(inspected.tag, 'input');
  assert.match(marked.text, /Ada/);
  assert.equal(scrolled.atBottom, true);
  assert.equal(Buffer.from(capture.base64, 'base64').subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.deepEqual(resized.viewport, { mode: 'mobile', width: 390, height: 844 });
  assert.equal(back.title, 'Fixture');
  assert.equal(forward.title, 'Next');

  await runtime.perform('browser.back', {});
  await runtime.perform('browser.scroll', { direction: 'top' });
  const frame = await runtime.surfaceFrame({ after: 0, wait: 10_000 });
  await runtime.surfaceInput([
    { type: 'pointer', action: 'down', x: 30, y: 30, button: 0, buttons: 1, modifiers },
    { type: 'pointer', action: 'up', x: 30, y: 30, button: 0, buttons: 0, modifiers },
  ]);
  const afterPointer = await runtime.perform('browser.snapshot', {});
  const page = await runtime.ensurePage();
  const withinDocument = Promise.withResolvers();
  const stopWatchingNavigation = page.cdp.onEvent((event) => {
    if (event.sessionId === page.sessionId && event.method === 'Page.navigatedWithinDocument') withinDocument.resolve();
  });
  await runtime.surfaceInput([
    { type: 'pointer', action: 'down', x: 30, y: 240, button: 0, buttons: 1, modifiers },
    { type: 'pointer', action: 'up', x: 30, y: 240, button: 0, buttons: 0, modifiers },
  ]);
  await withinDocument.promise;
  stopWatchingNavigation();
  assert.equal(runtime.url, `${web.origin}/#section`);
  await runtime.surfaceResize({ width: 700, height: 500 });
  const afterSurfaceResize = await runtime.perform('browser.snapshot', {});
  const filled = await runtime.perform('browser.resize', { viewport: 'fill' });

  assert.equal(frame.mime, 'image/jpeg');
  assert.ok(frame.bytes.length > 100);
  assert.match(afterPointer.text, /Surface clicked/);
  assert.deepEqual(afterSurfaceResize.viewport, { mode: 'mobile', width: 390, height: 844 });
  assert.deepEqual(filled.viewport, { mode: 'custom', width: 700, height: 500 });

  runtime.surfaceControl('user');
  await assert.rejects(
    runtime.perform('browser.snapshot', {}),
    /user controls the browser/i,
  );
  runtime.surfaceControl('agent');
  assert.match((await runtime.perform('browser.snapshot', {})).text, /Browser fixture/);
});

test('removes the temporary Chrome profile on shutdown', { skip: chromePath ? false : 'Chrome is unavailable' }, async () => {
  const chrome = createChromeProcess({ chromePath });
  const running = await chrome.ensure();
  const profileDir = running.profileDir;

  await chrome.close();

  assert.equal(fs.existsSync(profileDir), false);
  assert.notEqual(running.process.exitCode === null && running.process.signalCode === null, true);
});

test('keeps a configured Chrome profile across shutdown and relaunch', { skip: chromePath ? false : 'Chrome is unavailable' }, async (context) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'openchamber-server-browser-persistent-'));
  context.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const profileDir = path.join(root, 'chat-profile');

  const first = createChromeProcess({ chromePath, userDataDir: profileDir });
  const running = await first.ensure();
  assert.equal(running.profileDir, profileDir);
  await first.close();
  assert.equal(fs.existsSync(profileDir), true);
  assert.notEqual(fs.readdirSync(profileDir).length, 0);

  const second = createChromeProcess({ chromePath, userDataDir: profileDir });
  try {
    await second.ensure();
  } finally {
    await second.close();
  }
  assert.equal(fs.existsSync(profileDir), true);
});

test('presents itself as regular Chrome, which Google sign-in requires', { skip: chromePath ? false : 'Chrome is unavailable' }, async (context) => {
  // Given a page that shows the headers its request came with.
  const web = await startWebFixture();
  context.after(() => close(web.server));
  const runtime = createBrowserRuntime({ chromePath, allowedOrigins: [web.origin] });
  context.after(() => runtime.close());

  // When the browser opens it.
  await runtime.perform('browser.open', { url: `${web.origin}/headers` });
  const page = await runtime.ensurePage();
  const evaluate = async (expression) => (await page.cdp.sendSession(page.sessionId, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
  })).result.value;

  // Then neither the request nor the page says the browser is headless or automated, and the client hints stay.
  const sent = JSON.parse(await evaluate('document.querySelector("#headers").textContent'));
  assert.match(sent.userAgent, / Chrome\/\d+\.0\.0\.0 /);
  assert.doesNotMatch(sent.userAgent, /Headless/);
  assert.match(sent.hints ?? '', /Chromium/);
  assert.equal(await evaluate('navigator.userAgent'), sent.userAgent);
  assert.equal(await evaluate('navigator.webdriver'), false);
});

test('recovers a stale same-host Chrome lock in a persistent profile', { skip: chromePath ? false : 'Chrome is unavailable' }, async (context) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'openchamber-server-browser-lock-'));
  context.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const profileDir = path.join(root, 'chat-profile');
  const leaseDir = path.join(profileDir, '.openchamber-lease');
  await fs.promises.mkdir(profileDir, { recursive: true });
  await fs.promises.symlink(`${os.hostname()}-2147483647`, path.join(profileDir, 'SingletonLock'));
  await fs.promises.symlink('123456', path.join(profileDir, 'SingletonCookie'));
  await fs.promises.symlink('/tmp/openchamber-missing-socket', path.join(profileDir, 'SingletonSocket'));

  const chrome = createChromeProcess({ chromePath, userDataDir: profileDir });
  try {
    const running = await chrome.ensure();
    assert.equal(running.profileDir, profileDir);
  } finally {
    await chrome.close();
  }
  assert.equal(lstatExists(path.join(profileDir, 'SingletonLock')), false);
  assert.equal(fs.existsSync(leaseDir), false);
});

test('refuses a foreign lock on first migration and releases its lease', { skip: chromePath ? false : 'Chrome is unavailable' }, async (context) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'openchamber-server-browser-migration-'));
  context.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const profileDir = path.join(root, 'chat-profile');
  await fs.promises.mkdir(profileDir, { recursive: true });
  await fs.promises.symlink('old-container-123', path.join(profileDir, 'SingletonLock'));

  const chrome = createChromeProcess({ chromePath, userDataDir: profileDir });
  try {
    await assert.rejects(chrome.ensure(), /no prior lease/i);
    assert.equal(lstatExists(path.join(profileDir, 'SingletonLock')), true);
    assert.equal(fs.existsSync(path.join(profileDir, '.openchamber-lease')), false);
  } finally {
    await chrome.close();
  }
});

test('retries Chrome startup after a failed launch', { skip: chromePath ? false : 'Chrome is unavailable' }, async (context) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'openchamber-server-browser-retry-'));
  context.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const marker = path.join(root, 'failed-once');
  const wrapper = path.join(root, 'chrome-wrapper.sh');
  await fs.promises.writeFile(wrapper, `#!/bin/sh
case " $* " in
  *" --remote-debugging-port=0 "*)
    if [ ! -f "${marker}" ]; then
      : > "${marker}"
      echo "fake startup failure" >&2
      exit 21
    fi
    ;;
esac
exec "${chromePath}" "$@"
`, { mode: 0o755 });
  const profileDir = path.join(root, 'chat-profile');
  const chrome = createChromeProcess({ chromePath: wrapper, userDataDir: profileDir, startupTimeoutMs: 5_000 });
  try {
    await assert.rejects(chrome.ensure(), /code 21[\s\S]*fake startup failure/);
    const running = await chrome.ensure();
    assert.equal(running.profileDir, profileDir);
  } finally {
    await chrome.close();
  }
});

test('stops Chrome at once on close even when its page no longer answers', { skip: chromePath ? false : 'Chrome is unavailable' }, async (context) => {
  // Given a page stuck in an endless loop, with native select styles that a graceful close would try to undo there.
  const web = await startWebFixture();
  context.after(() => close(web.server));
  const runtime = createBrowserRuntime({ chromePath, allowedOrigins: [web.origin] });
  context.after(() => runtime.close());
  await runtime.perform('browser.open', { url: `${web.origin}/hang` });
  await runtime.setNativeSelectCompatibility(true);
  const page = await runtime.ensurePage();
  void page.cdp.sendSession(page.sessionId, 'Runtime.evaluate', { expression: 'document.querySelector("#hang").click()' }).catch(() => {});

  // When the runtime closes, then it finishes well inside the five seconds the host waits before killing the service.
  const started = Date.now();
  await runtime.close();
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2_500, `closing took ${elapsed} ms`);
});


test('reload reloads the document even when its URL contains a fragment', { skip: chromePath ? false : 'Chrome is unavailable' }, async (context) => {
  const web = await startWebFixture();
  context.after(() => close(web.server));
  const runtime = createBrowserRuntime({ chromePath, allowedOrigins: [web.origin] });
  context.after(() => runtime.close());
  await runtime.perform('browser.open', { url: `${web.origin}/#section` });
  await runtime.perform('browser.type', { selector: '#name', value: 'Before reload', submit: false });
  await runtime.perform('browser.click', { selector: '#mark' });
  assert.match((await runtime.perform('browser.snapshot', {})).text, /Before reload/);
  await runtime.command('reload');
  const snapshotText = () => runtime.perform('browser.snapshot', {}).then((snapshot) => snapshot.text, () => '');
  await waitFor(async () => /Waiting/.test(await snapshotText()));
  assert.equal(runtime.url, `${web.origin}/#section`);
  assert.doesNotMatch(await snapshotText(), /Before reload/);
});

test('applies and removes native select compatibility without reloading page state', { skip: chromePath ? false : 'Chrome is unavailable' }, async (context) => {
  // Given a CSP-protected page with native, listbox, and custom dropdown controls.
  const web = await startWebFixture();
  context.after(() => close(web.server));
  const runtime = createBrowserRuntime({ chromePath, allowedOrigins: [web.origin] });
  context.after(() => runtime.close());
  await runtime.perform('browser.open', { url: `${web.origin}/selects` });
  await runtime.perform('browser.type', { selector: '#name', value: 'Preserved', submit: false });
  const page = await runtime.ensurePage();
  const appearances = async () => {
    const result = await page.cdp.sendSession(page.sessionId, 'Runtime.evaluate', {
      expression: `JSON.stringify({
        native: getComputedStyle(document.querySelector('#native')).appearance,
        listbox: getComputedStyle(document.querySelector('#listbox')).appearance,
        custom: getComputedStyle(document.querySelector('#custom')).appearance,
        value: document.querySelector('#name').value,
      })`,
      returnByValue: true,
    });
    return JSON.parse(result.result.value);
  };
  const before = await appearances();

  // When compatibility is enabled, then only the single-choice native select opts in.
  await runtime.setNativeSelectCompatibility(true);
  const enabled = await appearances();
  assert.equal(enabled.native, 'base-select');
  assert.equal(enabled.listbox, before.listbox);
  assert.equal(enabled.custom, before.custom);
  assert.equal(enabled.value, 'Preserved');

  // When the page navigates and compatibility is disabled, then it follows navigation and reverses without reload.
  await runtime.command('reload');
  let afterReload = null;
  await waitFor(async () => {
    afterReload = await appearances().catch(() => null);
    return afterReload?.value === 'initial' && afterReload.native === 'base-select';
  });
  assert.equal(afterReload.native, 'base-select');
  await runtime.perform('browser.type', { selector: '#name', value: 'Still here', submit: false });
  await runtime.setNativeSelectCompatibility(false);
  const disabled = await appearances();
  assert.equal(disabled.native, before.native);
  assert.equal(disabled.value, 'Still here');
});


test('flushes coalesced pointer moves before a click', { skip: chromePath ? false : 'Chrome is unavailable' }, async (context) => {
  const web = await startWebFixture();
  context.after(() => close(web.server));
  const runtime = createBrowserRuntime({ chromePath, allowedOrigins: [web.origin] });
  context.after(() => runtime.close());
  await runtime.perform('browser.open', { url: `${web.origin}/` });
  const page = await runtime.ensurePage();
  const evaluate = async (expression) => (await page.cdp.sendSession(page.sessionId, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
  })).result.value;
  await evaluate(`(() => {
    window.inputOrder = [];
    const record = (name) => (event) => {
      window.inputOrder.push(name + ':' + Math.round(event.clientX) + ',' + Math.round(event.clientY));
    };
    addEventListener('pointermove', record('move'), true);
    addEventListener('pointerdown', record('down'), true);
    addEventListener('pointerup', record('up'), true);
    document.querySelector('#surface').addEventListener('click', () => window.inputOrder.push('click'));
  })()`);
  const pointer = (action, x, y, buttons) => ({ type: 'pointer', action, x, y, button: 0, buttons, modifiers });

  // Given two hover moves before a click, the last move reaches the page before the press.
  await runtime.surfaceInput([
    pointer('move', 20, 20, 0),
    pointer('move', 30, 30, 0),
    pointer('down', 30, 30, 1),
    pointer('up', 30, 30, 0),
  ]);
  await waitFor(async () => (await evaluate('window.inputOrder.length')) >= 4);

  assert.deepEqual(JSON.parse(await evaluate('JSON.stringify(window.inputOrder)')), [
    'move:30,30',
    'down:30,30',
    'up:30,30',
    'click',
  ]);
});

test('types editing keys, Enter, select-all, and composed characters like a local keyboard', { skip: chromePath ? false : 'Chrome is unavailable' }, async (context) => {
  // Given a page with a textarea and a single-field form.
  const web = await startWebFixture();
  context.after(() => close(web.server));
  const runtime = createBrowserRuntime({ chromePath, allowedOrigins: [web.origin] });
  context.after(() => runtime.close());
  await runtime.perform('browser.open', { url: `${web.origin}/keys` });
  const page = await runtime.ensurePage();
  const evaluate = async (expression) => (await page.cdp.sendSession(page.sessionId, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
  })).result.value;
  const press = (key, code, pressed = {}) => runtime.surfaceInput(['down', 'up'].map((action) => ({
    type: 'key', action, key, code, modifiers: { ...modifiers, ...pressed },
  })));

  // When the viewer types text, Enter, AltGr and Option characters, and two shortcuts.
  await evaluate('document.querySelector("#notes").focus()');
  await press('a', 'KeyA');
  await press('Enter', 'Enter');
  await press('b', 'KeyB');
  await press('@', 'KeyQ', { ctrl: true, alt: true });
  await press('@', 'Digit2', { alt: true });
  await press('c', 'KeyC', { ctrl: true });
  await press('d', 'KeyD', { alt: true });
  await press('#', 'Digit3', { shift: true });
  await press('$', 'Digit4', { shift: true });
  await press('%', 'Digit5', { shift: true });
  await press('^', 'Digit6', { shift: true });
  await press('&', 'Digit7', { shift: true });
  await press('(', 'Digit9', { shift: true });

  // Then Enter adds a line, composed characters and shifted symbols are typed,
  // and shortcuts type nothing.
  assert.equal(await evaluate('document.querySelector("#notes").value'), 'a\nb@@#$%^&(');

  // When the caret moves with End and Home, and Meta+A selects the field.
  await evaluate('document.querySelector("#field").focus(); document.querySelector("#field").setSelectionRange(5, 5)');
  const selection = 'JSON.stringify([document.querySelector("#field").selectionStart, document.querySelector("#field").selectionEnd])';
  await press('End', 'End');
  const afterEnd = await evaluate(selection);
  await press('Home', 'Home');
  const afterHome = await evaluate(selection);
  await press('a', 'KeyA', { meta: true });
  const afterSelectAll = await evaluate(selection);
  await press('Enter', 'Enter');

  // Then each key runs Chrome's default action, and Enter submits the form.
  assert.equal(afterEnd, '[11,11]');
  assert.equal(afterHome, '[0,0]');
  assert.equal(afterSelectAll, '[0,11]');
  assert.equal(await evaluate('document.querySelector("#submits").textContent'), '1');
});

test('does not reuse a cut after the pointer moves to another selection', { skip: chromePath ? false : 'Chrome is unavailable' }, async (context) => {
  // Given a page whose text was cut, then another selection made with the pointer.
  const web = await startWebFixture();
  context.after(() => close(web.server));
  const runtime = createBrowserRuntime({ chromePath, allowedOrigins: [web.origin] });
  context.after(() => runtime.close());
  await runtime.perform('browser.open', { url: `${web.origin}/keys` });
  const page = await runtime.ensurePage();
  const evaluate = async (expression) => (await page.cdp.sendSession(page.sessionId, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
  })).result.value;
  await evaluate('(() => { const notes = document.querySelector("#notes"); notes.value = "cut this"; notes.focus(); notes.setSelectionRange(0, 3); })()');
  await runtime.surfaceInput(['down', 'up'].map((action) => ({
    type: 'key', action, key: 'x', code: 'KeyX', modifiers: { ...modifiers, ctrl: true },
  })));
  await runtime.surfaceInput([
    { type: 'pointer', action: 'down', x: 1, y: 1, button: 0, buttons: 1, modifiers },
    { type: 'pointer', action: 'up', x: 1, y: 1, button: 0, buttons: 0, modifiers },
  ]);
  await evaluate('(() => { const notes = document.querySelector("#notes"); notes.value = "other"; notes.focus(); notes.setSelectionRange(0, 5); })()');

  // Then a later clipboard read returns the new selection, never the old cut.
  assert.equal(await runtime.surfaceClipboard(), 'other');
});

test('sends function-key codes, keypad location, and held-key repeat', { skip: chromePath ? false : 'Chrome is unavailable' }, async (context) => {
  // Given a page that records the raw keyboard fields the page receives.
  const web = await startWebFixture();
  context.after(() => close(web.server));
  const runtime = createBrowserRuntime({ chromePath, allowedOrigins: [web.origin] });
  context.after(() => runtime.close());
  await runtime.perform('browser.open', { url: `${web.origin}/keys` });
  const page = await runtime.ensurePage();
  const evaluate = async (expression) => (await page.cdp.sendSession(page.sessionId, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
  })).result.value;
  await evaluate(`window.keyLog = [];
    document.addEventListener('keydown', (event) => window.keyLog.push({
      key: event.key, code: event.code, keyCode: event.keyCode,
      location: event.location, repeat: event.repeat,
    }), true)`);
  const press = (key, code, pressed = {}) => runtime.surfaceInput(['down', 'up'].map((action) => ({
    type: 'key', action, key, code, modifiers: { ...modifiers, ...pressed },
  })));

  // When the viewer presses function keys, a keypad key, and holds Shift.
  await press('F1', 'F1');
  await press('F2', 'F2');
  await press('F9', 'F9');
  await press('1', 'Numpad1');
  await runtime.surfaceInput([1, 2].map(() => ({
    type: 'key', action: 'down', key: 'Shift', code: 'ShiftLeft', modifiers: { ...modifiers, shift: true },
  })));
  await runtime.surfaceInput([{ type: 'key', action: 'up', key: 'Shift', code: 'ShiftLeft', modifiers: modifiers }]);

  // Then VK codes, keypad location, and repeat reach the page.
  const log = JSON.parse(await evaluate('JSON.stringify(window.keyLog)'));
  assert.deepEqual(log.slice(0, 4).map(({ key, keyCode }) => [key, keyCode]), [
    ['F1', 112], ['F2', 113], ['F9', 120], ['1', 97],
  ]);
  assert.equal(log[3].location, 3);
  assert.equal(log[4].location, 1);
  assert.equal(log[4].repeat, false);
  assert.equal(log[5].repeat, true);
});

test('copies the focused selection through shadow roots and same-origin frames but never a password', { skip: chromePath ? false : 'Chrome is unavailable' }, async (context) => {
  // Given a page with a password field, an open shadow root, and a same-origin frame.
  const web = await startWebFixture();
  context.after(() => close(web.server));
  const runtime = createBrowserRuntime({ chromePath, allowedOrigins: [web.origin] });
  context.after(() => runtime.close());
  await runtime.perform('browser.open', { url: `${web.origin}/copy` });
  const page = await runtime.ensurePage();
  const select = (expression) => page.cdp.sendSession(page.sessionId, 'Runtime.evaluate', { expression });

  // When text is selected in each place, then only readable selections are copied.
  await select('const s = document.querySelector("#host").shadowRoot.querySelector("#shadowed"); s.focus(); s.setSelectionRange(0, 6)');
  assert.equal(await runtime.surfaceClipboard(), 'shadow');
  await select('const t = document.querySelector("#frame").contentDocument.querySelector("#inner"); t.focus(); t.setSelectionRange(0, 5)');
  assert.equal(await runtime.surfaceClipboard(), 'frame');
  await select('const p = document.querySelector("#secret"); p.focus(); p.select()');
  assert.equal(await runtime.surfaceClipboard(), '');
});

test('cuts the selection and keeps its text for the host clipboard', { skip: chromePath ? false : 'Chrome is unavailable' }, async (context) => {
  // Given a focused textarea with a selection.
  const web = await startWebFixture();
  context.after(() => close(web.server));
  const runtime = createBrowserRuntime({ chromePath, allowedOrigins: [web.origin] });
  context.after(() => runtime.close());
  await runtime.perform('browser.open', { url: `${web.origin}/keys` });
  const page = await runtime.ensurePage();
  const evaluate = async (expression) => (await page.cdp.sendSession(page.sessionId, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
  })).result.value;
  await evaluate('const notes = document.querySelector("#notes"); notes.value = "cut this"; notes.focus(); notes.setSelectionRange(0, 3)');

  // When the viewer cuts, the page removes the selection and the host can still
  // read what was cut, even though the selection is gone by then.
  await runtime.surfaceInput(['down', 'up'].map((action) => ({
    type: 'key', action, key: 'x', code: 'KeyX', modifiers: { ...modifiers, ctrl: true },
  })));

  // Then the cut reached the page and the copied text survived for the host,
  // and consuming it also cleared the dock's pending clipboard request.
  assert.equal(await evaluate('document.querySelector("#notes").value'), ' this');
  const cut = runtime.cutRequest;
  assert.equal(cut.text, 'cut');
  assert.equal(await runtime.surfaceClipboard(), 'cut');
  assert.equal(runtime.cutRequest, null);
});

test('drags across page text to select it like a held mouse button', { skip: chromePath ? false : 'Chrome is unavailable' }, async (context) => {
  // Given a page with a heading.
  const web = await startWebFixture();
  context.after(() => close(web.server));
  const runtime = createBrowserRuntime({ chromePath, allowedOrigins: [web.origin] });
  context.after(() => runtime.close());
  await runtime.perform('browser.open', { url: `${web.origin}/next` });

  // When the viewer moves with the button held, as hosts report moves, then the text is selected.
  await runtime.surfaceInput([
    { type: 'pointer', action: 'down', x: 2, y: 40, button: 0, buttons: 1, modifiers },
    { type: 'pointer', action: 'move', x: 80, y: 40, button: -1, buttons: 1, modifiers },
    { type: 'pointer', action: 'move', x: 200, y: 40, button: -1, buttons: 1, modifiers },
    { type: 'pointer', action: 'up', x: 200, y: 40, button: 0, buttons: 0, modifiers },
  ]);
  assert.equal(await runtime.surfaceClipboard(), 'Next page');
});

test('replaces a scope whose Chrome stopped with a fresh browser on the next action', { skip: chromePath ? false : 'Chrome is unavailable' }, async (context) => {
  // Given a chat whose scope runs a real Chrome.
  const web = await startWebFixture();
  context.after(() => close(web.server));
  const runtimes = [];
  const manager = createBrowserManager({
    createRuntime: () => {
      const runtime = createBrowserRuntime({ chromePath, allowedOrigins: [web.origin] });
      runtimes.push(runtime);
      return runtime;
    },
  });
  context.after(() => manager.close());
  const chat = { directory: '/repo', sessionId: 'ses_crash' };
  await manager.perform('browser.open', { url: `${web.origin}/` }, undefined, chat);
  const page = await runtimes[0].ensurePage();

  // When that Chrome exits.
  await page.cdp.send('Browser.close').catch(() => {});
  await waitFor(() => manager.state().notice !== null);

  // Then the old runtime refuses work, and the chat's next action starts a new browser.
  assert.deepEqual(manager.state().scopes, []);
  await assert.rejects(runtimes[0].perform('browser.snapshot', {}), /stopped unexpectedly|closed/);
  const reopened = await manager.perform('browser.open', { url: `${web.origin}/next` }, undefined, chat);
  assert.equal(reopened.title, 'Next');
  assert.equal(runtimes.length, 2);
});

test('tracks title, loading, and history for the dock, and stops a slow load', { skip: chromePath ? false : 'Chrome is unavailable' }, async (context) => {
  // Given a page whose title changes when the user clicks it.
  const web = await startWebFixture();
  context.after(() => close(web.server));
  const runtime = createBrowserRuntime({ chromePath, allowedOrigins: [web.origin] });
  context.after(() => runtime.close());
  await runtime.perform('browser.open', { url: `${web.origin}/title` });

  // When the user clicks it, then the title follows the page rather than the last agent action.
  await runtime.surfaceInput([
    { type: 'pointer', action: 'down', x: 30, y: 30, button: 0, buttons: 1, modifiers },
    { type: 'pointer', action: 'up', x: 30, y: 30, button: 0, buttons: 0, modifiers },
  ]);
  await waitFor(() => runtime.title === 'Renamed by the page');

  // When the dock navigates and goes back, then history availability follows.
  await runtime.command('navigate', { url: `${web.origin}/next` });
  await waitFor(() => runtime.title === 'Next' && runtime.canGoBack && !runtime.isLoading);
  assert.equal(runtime.canGoForward, false);
  await runtime.command('back');
  await waitFor(() => runtime.url === `${web.origin}/title` && runtime.canGoForward);

  // When a slow page is stopped, then loading ends without waiting for the server.
  await runtime.command('navigate', { url: `${web.origin}/slow` });
  await waitFor(() => runtime.isLoading);
  await runtime.command('stop');
  await waitFor(() => !runtime.isLoading, 2_000);

  // Then the dock still refuses anything but http(s).
  await assert.rejects(runtime.command('navigate', { url: 'file:///etc/passwd' }), /http\(s\)/);
});

test('follows pages the site opens as tabs and returns to the opener when they close', { skip: chromePath ? false : 'Chrome is unavailable' }, async (context) => {
  // Given a page with a target=_blank link and a window.open button.
  const web = await startWebFixture();
  context.after(() => close(web.server));
  const runtime = createBrowserRuntime({ chromePath, allowedOrigins: [web.origin] });
  context.after(() => runtime.close());
  await runtime.perform('browser.open', { url: `${web.origin}/tabs` });
  const opener = runtime.tabs[0].id;
  const click = (x, y) => runtime.surfaceInput([
    { type: 'pointer', action: 'down', x, y, button: 0, buttons: 1, modifiers },
    { type: 'pointer', action: 'up', x, y, button: 0, buttons: 0, modifiers },
  ]);

  // When the user follows the link, then the new page becomes the active tab, and the agent stays in its own until it names the new one.
  await click(30, 30);
  await waitFor(() => runtime.tabs.length === 2 && runtime.url === `${web.origin}/next`);
  assert.equal((await runtime.perform('browser.snapshot', {})).title, 'Tabs');
  const followed = runtime.tabs.find((tab) => tab.active).id;
  assert.equal((await runtime.perform('browser.snapshot', { tabId: followed })).title, 'Next');

  // When that tab closes, then its opener comes back.
  await runtime.command('tab-close', { tabId: runtime.tabs.find((tab) => tab.active).id });
  assert.deepEqual(runtime.tabs.map((tab) => [tab.id, tab.active]), [[opener, true]]);

  // When the page opens a window from script, then it is tracked and brought forward too.
  await click(30, 128);
  await waitFor(() => runtime.tabs.length === 2 && runtime.url === `${web.origin}/next`);

  // When the dock opens a blank tab and selects the opener again, then the viewer follows the dock, and the
  // agent, whose last tab closed, works in the newest tab it opened.
  await runtime.command('tab-new');
  assert.equal(runtime.tabs.length, 3);
  assert.equal(runtime.url, 'about:blank');
  assert.equal((await runtime.perform('browser.snapshot', {})).title, 'Tabs');
  await runtime.command('tab-select', { tabId: opener });
  assert.equal(runtime.url, `${web.origin}/tabs`);
});

test('lets the agent name tabs by id without moving the viewer off its tab', { skip: chromePath ? false : 'Chrome is unavailable' }, async (context) => {
  // Given a new browser, whose first page loads in the blank tab the viewer sees.
  const web = await startWebFixture();
  context.after(() => close(web.server));
  const runtime = createBrowserRuntime({ chromePath, allowedOrigins: [web.origin] });
  context.after(() => runtime.close());
  const first = await runtime.perform('browser.open', { url: `${web.origin}/next` });
  const shown = first.tabId;
  assert.deepEqual(runtime.tabs.map((tab) => [tab.id, tab.active]), [[shown, true]]);
  const before = await runtime.surfaceFrame({ after: 0, wait: 10_000 });
  assert.ok(before, 'the viewer got no frame of its page');

  // When the agent opens another page, then it gets a background tab, the viewer stays put, and actions
  // without a tab id follow the agent there.
  const opened = await runtime.perform('browser.open', { url: `${web.origin}/` });
  assert.notEqual(opened.tabId, shown);
  assert.equal(opened.title, 'Fixture');
  const snapshot = await runtime.perform('browser.snapshot', {});
  assert.equal(snapshot.title, 'Fixture');
  assert.deepEqual(snapshot.tabs, [
    { id: shown, title: 'Next', url: `${web.origin}/next`, active: true },
    { id: opened.tabId, title: 'Fixture', url: `${web.origin}/`, active: false },
  ]);

  // When actions name the background tab, then they run there, and it keeps painting so a capture cannot stall.
  const background = await runtime.agentPage(opened.tabId);
  const visibility = await background.cdp.sendSession(background.sessionId, 'Runtime.evaluate', { expression: 'document.visibilityState', returnByValue: true });
  assert.equal(visibility.result.value, 'visible');
  await runtime.perform('browser.type', { tabId: opened.tabId, selector: '#name', value: 'from the agent', submit: false });
  await runtime.perform('browser.click', { tabId: opened.tabId, selector: '#mark' });
  assert.match((await runtime.perform('browser.snapshot', { tabId: opened.tabId })).text, /from the agent/);
  const capture = await runtime.perform('browser.capture', { tabId: opened.tabId });
  assert.equal(capture.title, 'Fixture');
  assert.ok(capture.base64.length > 100);
  await runtime.perform('browser.open', { tabId: opened.tabId, url: `${web.origin}/title` });
  await runtime.perform('browser.back', { tabId: opened.tabId });
  assert.equal((await runtime.perform('browser.snapshot', { tabId: opened.tabId })).title, 'Fixture');
  assert.equal(runtime.url, `${web.origin}/next`);
  assert.equal(runtime.tabs.find((tab) => tab.active).id, shown);

  // When the agent names the viewer's tab, then its later actions without an id stay there.
  await runtime.perform('browser.snapshot', { tabId: shown });
  assert.equal((await runtime.perform('browser.snapshot', {})).title, 'Next');

  // When an id is not one this browser issued, then the action is refused instead of running elsewhere.
  await assert.rejects(runtime.perform('browser.click', { tabId: 'missing', selector: '#mark' }), /no tab "missing"/);

  // Then the viewer's page stayed in front and kept streaming the whole time.
  const page = await runtime.ensurePage();
  const evaluate = async (expression) => (await page.cdp.sendSession(page.sessionId, 'Runtime.evaluate', { expression, returnByValue: true })).result.value;
  assert.equal(await evaluate('document.visibilityState'), 'visible');
  const next = runtime.surfaceFrame({ after: before.sequence, wait: 10_000 });
  await evaluate('document.body.style.background = "rgb(10, 120, 200)"');
  assert.ok(await next, 'the viewer stopped getting frames of its page');
});

test('closes only the tabs the agent opened, newest first', { skip: chromePath ? false : 'Chrome is unavailable' }, async (context) => {
  // Given the agent's first page, a tab the viewer opened and navigated, and the agent's background tab.
  const web = await startWebFixture();
  context.after(() => close(web.server));
  const runtime = createBrowserRuntime({ chromePath, allowedOrigins: [web.origin] });
  context.after(() => runtime.close());
  const first = await runtime.perform('browser.open', { url: `${web.origin}/next` });
  await runtime.command('tab-new');
  await runtime.command('navigate', { url: `${web.origin}/title` });
  await waitFor(() => runtime.url === `${web.origin}/title` && runtime.canGoBack);
  const viewerTab = runtime.tabs.find((tab) => tab.active).id;
  const background = await runtime.perform('browser.open', { url: `${web.origin}/` });

  // When the agent names the viewer's tab or one that does not exist, then nothing closes.
  await assert.rejects(runtime.perform('browser.close', { tabId: viewerTab }), /not opened by the agent/);
  await assert.rejects(runtime.perform('browser.close', { tabId: 'missing' }), /no tab "missing"/);
  assert.equal(runtime.tabs.length, 3);

  // When it closes without a tab id, then its newest tab goes first, then its older one.
  assert.deepEqual(await runtime.perform('browser.close', {}), { closed: true, tabId: background.tabId });
  assert.deepEqual(await runtime.perform('browser.close', {}), { closed: true, tabId: first.tabId });
  await assert.rejects(runtime.perform('browser.close', {}), /no tab of its own/);

  // Then the viewer's tab is the one left, still in front.
  assert.deepEqual(runtime.tabs.map((tab) => [tab.id, tab.active]), [[viewerTab, true]]);
});

test('selects native options by exact label or value and lists them in a scoped snapshot', { skip: chromePath ? false : 'Chrome is unavailable' }, async (context) => {
  // Given a page with a native select inside a dialog, a multiple select, a long select, and a custom control.
  const web = await startWebFixture();
  context.after(() => close(web.server));
  const runtime = createBrowserRuntime({ chromePath, allowedOrigins: [web.origin] });
  context.after(() => runtime.close());
  await runtime.perform('browser.open', { url: `${web.origin}/form` });
  const page = await runtime.ensurePage();
  const evaluate = async (expression) => (await page.cdp.sendSession(page.sessionId, 'Runtime.evaluate', { expression, returnByValue: true })).result.value;

  // When the agent reads the page, then each select lists its options, capped and flagged when cut.
  const snapshot = await runtime.perform('browser.snapshot', {});
  const country = snapshot.elements.find((element) => element.selector === '#country');
  const long = snapshot.elements.find((element) => element.selector === '#long');
  assert.equal(country.multiple, false);
  assert.deepEqual(country.options.slice(1, 5), [
    { label: 'Canada (CA)', value: 'ca', selected: false, disabled: false },
    { label: 'United States', value: 'us', selected: false, disabled: false },
    { label: 'Mexico', value: 'mx', selected: false, disabled: true },
    { label: 'Nowhere', value: 'xx', selected: false, disabled: true },
  ]);
  assert.equal(country.optionsTruncated, undefined);
  assert.equal(snapshot.elements.find((element) => element.selector === '#many').multiple, true);
  assert.equal(long.options.length, 32);
  assert.equal(long.options[0].label.length, 80);
  assert.equal(long.optionsTruncated, true);

  // When the snapshot is scoped, then its text comes from that element alone.
  const scoped = await runtime.perform('browser.snapshot', { selector: '#dialog' });
  assert.match(scoped.text, /Inside the dialog/);
  assert.doesNotMatch(scoped.text, /Outside the dialog/);

  // When it selects by label and then by value, then the page sees each change.
  assert.deepEqual(await runtime.perform('browser.select', { selector: '#country', label: 'Canada (CA)' }), {
    selector: '#country', label: 'Canada (CA)', value: 'ca', url: `${web.origin}/form`,
  });
  assert.equal((await runtime.perform('browser.select', { selector: '#country', value: 'us' })).label, 'United States');
  assert.equal(await evaluate('window.changes'), 2);

  // When a request is ambiguous, disabled, missing, or for another kind of control, then the page is left as it was.
  const refusals = [
    [{ selector: '#country', label: 'Twin' }, /More than one option/],
    [{ selector: '#country', value: 'mx' }, /disabled/],
    [{ selector: '#country', value: 'xx' }, /disabled/],
    [{ selector: '#country', label: 'Atlantis' }, /No option/],
    [{ selector: '#country', label: 'US', value: 'us' }, /exactly one of label or value/],
    [{ selector: '#many', label: 'A' }, /Multiple selects/],
    [{ selector: '#custom', label: 'Custom' }, /not a native HTML select/],
  ];
  for (const [parameters, error] of refusals) await assert.rejects(runtime.perform('browser.select', parameters), error);
  assert.equal(await evaluate('document.querySelector("#country").value'), 'us');
  assert.equal(await evaluate('window.changes'), 2);
});

test('reports a page as settled only once it stops changing after its load', { skip: chromePath ? false : 'Chrome is unavailable' }, async (context) => {
  // Given an app that replaces its splash after a lazy fetch, and a page that never stops ticking.
  const web = await startWebFixture();
  context.after(() => close(web.server));
  const runtime = createBrowserRuntime({ chromePath, allowedOrigins: [web.origin] });
  context.after(() => runtime.close());

  // When the agent opens the app, then the answer waits for it and a snapshot right after shows it.
  const app = await runtime.perform('browser.open', { url: `${web.origin}/splash` });
  assert.equal(app.settled, true);
  assert.match((await runtime.perform('browser.snapshot', {})).text, /App ready/);

  // When the page keeps changing, then the open gives up waiting and says it has not settled.
  const started = Date.now();
  const busy = await runtime.perform('browser.open', { url: `${web.origin}/busy`, tabId: app.tabId });
  assert.equal(busy.settled, false);
  assert.ok(Date.now() - started < 8_000, `opening took ${Date.now() - started} ms`);
});

test('streams frames when the viewer\'s first frame request opens the page', { skip: chromePath ? false : 'Chrome is unavailable' }, async (context) => {
  // Given a scope with no page yet, like one opened from the dock for a chat.
  const web = await startWebFixture();
  context.after(() => close(web.server));
  const runtime = createBrowserRuntime({ chromePath, allowedOrigins: [web.origin] });
  context.after(() => runtime.close());

  // When the viewer asks for a frame first and the page then loads, then frames arrive.
  const frame = runtime.surfaceFrame({ after: 0, wait: 10_000 });
  await runtime.perform('browser.open', { url: web.origin });
  assert.ok(await frame, 'the stream opened with the page never delivered a frame');
});

test('sizes pages in CSS pixels for the viewer and keeps a chosen size fixed', { skip: chromePath ? false : 'Chrome is unavailable' }, async (context) => {
  // Given a visible scope in a panel measured at twice the CSS pixel density.
  const web = await startWebFixture();
  context.after(() => close(web.server));
  const runtimes = [];
  const manager = createBrowserManager({
    createRuntime: () => {
      const runtime = createBrowserRuntime({ chromePath, allowedOrigins: [web.origin] });
      runtimes.push(runtime);
      return runtime;
    },
  });
  context.after(() => manager.close());
  await manager.setDevicePixelRatio(2);
  await assert.rejects(manager.surfaceResize({ width: 1400, height: 1000 }), /no browser scope/i);
  await manager.perform('browser.open', { url: `${web.origin}/` }, undefined, { directory: '/repo', sessionId: 'ses_view' });
  const page = await runtimes[0].ensurePage();
  const innerSize = async () => (await page.cdp.sendSession(page.sessionId, 'Runtime.evaluate', {
    expression: 'JSON.stringify([innerWidth, innerHeight])',
    returnByValue: true,
  })).result.value;

  // Then the page lays out at the panel's CSS size.
  assert.equal(await innerSize(), '[700,500]');

  // When the dock fixes a size, then a later panel resize keeps it.
  await manager.setViewport({ mode: 'fixed', width: 500, height: 400, mobile: false }, manager.state().generation);
  await manager.surfaceResize({ width: 1200, height: 800 });
  assert.equal(await innerSize(), '[500,400]');
  assert.deepEqual(manager.state().scopes[0].viewport, { mode: 'fixed', source: 'viewer', width: 500, height: 400, mobile: false });

  // When the dock returns to Auto, then the page follows the latest panel size again.
  await manager.setViewport({ mode: 'auto', mobile: false }, manager.state().generation);
  assert.equal(await innerSize(), '[600,400]');
});

test('shows the viewer menu only for right clicks the page leaves alone', { skip: chromePath ? false : 'Chrome is unavailable' }, async (context) => {
  // Given a page with history, a plain area, and an element with its own menu.
  const web = await startWebFixture();
  context.after(() => close(web.server));
  // Viewer input goes through the manager, as the service sends it.
  let runtime;
  const manager = createBrowserManager({
    createRuntime: () => (runtime = createBrowserRuntime({ chromePath, allowedOrigins: [web.origin] })),
  });
  context.after(() => manager.close());
  const chat = { directory: '/repo', sessionId: 'ses_menu' };
  const first = await manager.perform('browser.open', { url: `${web.origin}/next` }, undefined, chat);
  await manager.perform('browser.open', { url: `${web.origin}/menu`, tabId: first.tabId }, undefined, chat);
  const page = await runtime.ensurePage();
  const evaluate = async (expression) => (await page.cdp.sendSession(page.sessionId, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
  })).result.value;
  const menuShown = () => evaluate('document.querySelector("openchamber-menu") !== null');
  const pointer = (action, x, y, button, buttons) => ({ type: 'pointer', action, x, y, button, buttons, modifiers });
  const rightClick = (x, y) => manager.surfaceInput([pointer('down', x, y, 2, 2), pointer('up', x, y, 2, 0)]);
  const leftClick = (x, y) => manager.surfaceInput([pointer('down', x, y, 0, 1), pointer('up', x, y, 0, 0)]);

  // When the page handles its own context menu, then the viewer menu stays away.
  await rightClick(30, 320);
  assert.equal(await menuShown(), false);
  assert.equal(await evaluate('document.title'), 'Custom menu');

  // When the page leaves a right click alone, then the menu appears, and Escape closes it without reaching the page.
  await rightClick(30, 30);
  assert.equal(await menuShown(), true);
  await manager.surfaceInput(['down', 'up'].map((action) => ({ type: 'key', action, key: 'Escape', code: 'Escape', modifiers })));
  assert.equal(await menuShown(), false);
  assert.equal(await evaluate('window.escapes'), 0);

  // When the user clicks outside the menu, then it closes and the page never sees that click.
  await rightClick(30, 30);
  await leftClick(600, 500);
  assert.equal(await menuShown(), false);
  assert.equal(await evaluate('window.clicks'), 0);
  assert.equal(await evaluate('typeof window.openchamberMenu'), 'undefined');

  // When Copy is chosen with text selected, then the text waits for the dock's toast.
  await evaluate('getSelection().selectAllChildren(document.querySelector("#words"))');
  await rightClick(30, 30);
  await leftClick(60, 142);
  await waitFor(() => runtime.copyRequest?.text === 'Copy these words');

  // When Back is chosen, then the tab goes back.
  await rightClick(30, 30);
  await leftClick(60, 49);
  await waitFor(() => runtime.url === `${web.origin}/next`);
});

test('captures console and network for the inspector and runs JavaScript in the page', { skip: chromePath ? false : 'Chrome is unavailable' }, async (context) => {
  // Given a capture on a page that logs and posts when clicked.
  const web = await startWebFixture();
  context.after(() => close(web.server));
  const runtime = createBrowserRuntime({ chromePath, allowedOrigins: [web.origin] });
  context.after(() => runtime.close());
  await runtime.perform('browser.open', { url: `${web.origin}/inspect` });
  const { captureId } = await runtime.inspectorStart();

  // When the user clicks, then the console error and the finished request are captured.
  await runtime.surfaceInput([
    { type: 'pointer', action: 'down', x: 30, y: 30, button: 0, buttons: 1, modifiers },
    { type: 'pointer', action: 'up', x: 30, y: 30, button: 0, buttons: 0, modifiers },
  ]);
  const consoleRows = [];
  const networkRows = new Map();
  let cursor = 0;
  await waitFor(() => {
    const batch = runtime.inspector.events(captureId, cursor);
    cursor = batch.cursor;
    consoleRows.push(...batch.console);
    for (const row of batch.network) networkRows.set(row.id, row);
    return consoleRows.some((row) => row.text === 'boom from page' && row.level === 'error')
      && [...networkRows.values()].some((row) => row.url.includes('/api') && row.state === 'complete');
  });
  const api = [...networkRows.values()].find((row) => row.url.includes('/api'));
  assert.match(api.url, /token=%5BREDACTED%5D/);
  assert.equal(runtime.problemCounts.errors, 1);

  // Then its details redact credentials in both bodies.
  const details = await runtime.inspector.request(captureId, api.id, true);
  assert.equal(details.bodyState, 'available');
  assert.deepEqual(JSON.parse(details.requestBody), { password: '[REDACTED]', name: 'ada' });
  assert.deepEqual(JSON.parse(details.responseBody), { token: '[REDACTED]', ok: true });

  // When JavaScript runs in the page, then promises resolve and exceptions come back as errors.
  assert.deepEqual(await runtime.inspector.evaluate(captureId, 'await Promise.resolve(document.title)'), { text: 'Inspect', truncated: false, isError: false });
  assert.equal((await runtime.inspector.evaluate(captureId, 'missingName')).isError, true);

  // When the page itself loads another document, then its problems start over, like the DevTools console.
  await runtime.inspector.evaluate(captureId, 'location.href = "/next"');
  await waitFor(() => runtime.url === `${web.origin}/next`);
  assert.deepEqual(runtime.problemCounts, { errors: 0, warnings: 0 });

  // When another tab comes forward, then this capture is gone.
  await runtime.command('tab-new');
  assert.throws(() => runtime.inspector.events(captureId, cursor), (error) => error.code === 'CAPTURE_GONE');
});

test('selects a native option by exact label or value', { skip: chromePath ? false : 'Chrome is unavailable' }, async (context) => {
  // Given a page with explicit labels, disabled choices, duplicates, and a multi-select.
  const web = await startWebFixture();
  context.after(() => close(web.server));
  const runtime = createBrowserRuntime({ chromePath, allowedOrigins: [web.origin] });
  context.after(() => runtime.close());
  await runtime.perform('browser.open', { url: `${web.origin}/selects` });

  // When the agent selects by value or by the label attribute, then the page changes.
  assert.deepEqual(await runtime.perform('browser.select', { selector: '#native', value: 'Two' }), {
    selector: '#native', label: 'Two', value: 'Two', url: `${web.origin}/selects`,
  });
  assert.deepEqual(await runtime.perform('browser.select', { selector: '#rich', label: 'Alpha explicit' }), {
    selector: '#rich', label: 'Alpha explicit', value: 'a', url: `${web.origin}/selects`,
  });
  assert.deepEqual(await runtime.perform('browser.select', { selector: '#empty-label', label: '' }), {
    selector: '#empty-label', label: '', value: 'e', url: `${web.origin}/selects`,
  });

  // Then input and change reach listeners exactly once.
  await runtime.perform('browser.select', { selector: '#evented', value: 'two' });
  const page = await runtime.ensurePage();
  const events = await page.cdp.sendSession(page.sessionId, 'Runtime.evaluate', {
    expression: 'JSON.stringify(window.selectEvents)',
    returnByValue: true,
  });
  assert.equal(events.result.value, '{"input":1,"change":1}');

  // But text that is not the label attribute does not match, and neither do ambiguous or unusable choices.
  await assert.rejects(runtime.perform('browser.select', { selector: '#rich', label: 'Ignored text' }), /No option/);
  await assert.rejects(runtime.perform('browser.select', { selector: '#rich', value: 'c' }), /matching option.*disabled/);
  await assert.rejects(runtime.perform('browser.select', { selector: '#rich', value: 'd' }), /matching option.*disabled/);
  await assert.rejects(runtime.perform('browser.select', { selector: '#disabled-select', value: 'f' }), /select.*disabled/);
  await assert.rejects(runtime.perform('browser.select', { selector: '#multi', value: 'x' }), /Multiple selects/);
  await assert.rejects(runtime.perform('browser.select', { selector: '#dupes', label: 'Same' }), /More than one option/);
  await assert.rejects(runtime.perform('browser.select', { selector: '#native', value: 'Missing' }), /No option/);
  await assert.rejects(runtime.perform('browser.select', { selector: 'input', value: 'Two' }), /not a native HTML select/);
  await assert.rejects(runtime.perform('browser.select', { selector: '[', value: 'Two' }), /Invalid selector/);
  await assert.rejects(runtime.perform('browser.select', { selector: '#native' }), /exactly one of label or value/);
  await assert.rejects(runtime.perform('browser.select', { selector: '#native', label: 'One', value: 'One' }), /exactly one of label or value/);
});

test('marks an element inside a same-origin iframe and keeps the frame chain', { skip: chromePath ? false : 'Chrome is unavailable' }, async (context) => {
  // Given a page with a same-origin frame and an armed marker.
  const web = await startWebFixture();
  context.after(() => close(web.server));
  const runtime = createBrowserRuntime({ chromePath, allowedOrigins: [web.origin] });
  context.after(() => runtime.close());
  await runtime.perform('browser.open', { url: `${web.origin}/copy` });
  const page = await runtime.ensurePage();
  await runtime.startMark('frame-test');

  // When the marker confirms over the textarea inside the frame.
  const point = await page.cdp.sendSession(page.sessionId, 'Runtime.evaluate', {
    expression: `(() => {
      const frame = document.querySelector('#frame');
      const outer = frame.getBoundingClientRect();
      const inner = frame.contentDocument.querySelector('#inner').getBoundingClientRect();
      return JSON.stringify({
        x: outer.left + frame.clientLeft + inner.left + inner.width / 2,
        y: outer.top + frame.clientTop + inner.top + inner.height / 2,
      });
    })()`,
    returnByValue: true,
  });
  assert.equal(await runtime.handleMarkInput({ type: 'pointer', action: 'down', button: 0, ...JSON.parse(point.result.value) }, page), true);

  // Then the mark keeps the frame chain and snapshot resolves it.
  assert.equal(runtime.markState.marks.length, 1);
  assert.deepEqual(runtime.markState.marks[0].frameSelectors, ['#frame']);
  assert.equal(runtime.markState.marks[0].tag, 'textarea');
  const snapshot = await runtime.perform('browser.snapshot', {});
  assert.equal(snapshot.marks.length, 1);
  assert.deepEqual(snapshot.marks[0].frameSelectors, ['#frame']);
  assert.equal(snapshot.marks[0].resolved, true);

  // And cancelling the next marker leaves the confirmed list alone.
  await runtime.startMark('frame-test-2');
  await runtime.handleMarkInput({ type: 'pointer', action: 'down', button: 2, x: 5, y: 5 }, page);
  assert.equal(runtime.markState.active, false);
  assert.equal(runtime.markState.marks.length, 1);
});

test('draws and hides the marker box from page-local pointer moves', { skip: chromePath ? false : 'Chrome is unavailable' }, async (context) => {
  // Given a page with a frame and an armed marker.
  const web = await startWebFixture();
  context.after(() => close(web.server));
  const runtime = createBrowserRuntime({ chromePath, allowedOrigins: [web.origin] });
  context.after(() => runtime.close());
  await runtime.perform('browser.open', { url: `${web.origin}/copy` });
  const page = await runtime.ensurePage();
  const contexts = [];
  const off = page.cdp.onEvent((event) => {
    if (event.method === 'Runtime.executionContextCreated' && event.sessionId === page.sessionId) {
      contexts.push(event.params.context);
    }
  });
  await page.cdp.sendSession(page.sessionId, 'Runtime.enable');
  await runtime.startMark('local-hover');
  let contextId = null;
  await waitFor(() => {
    contextId = contexts.find((candidate) => candidate.name === 'openchamber-mark')?.id ?? null;
    return Number.isInteger(contextId);
  });
  const read = async () => {
    const response = await page.cdp.sendSession(page.sessionId, 'Runtime.evaluate', {
      contextId,
      expression: 'globalThis.__openchamberMark?.describe?.() ?? null',
      returnByValue: true,
    });
    return response.result?.value ?? null;
  };
  const move = (x, y) => runtime.surfaceInput([
    { type: 'pointer', action: 'move', x, y, button: 0, buttons: 0, modifiers },
  ]);
  const centerOf = async (selector) => {
    const response = await page.cdp.sendSession(page.sessionId, 'Runtime.evaluate', {
      expression: `(() => {
        const rect = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      })()`,
      returnByValue: true,
    });
    return response.result.value;
  };

  // When the pointer moves over the input, then the page-local overlay draws it without a service hit test.
  await move(...Object.values(await centerOf('#secret')));
  await waitFor(async () => /input#secret/.test((await read())?.label ?? ''));
  const overInput = await read();
  assert.equal(overInput.hidden, false);
  assert.ok(Number.parseFloat(overInput.width) > 0);

  // But an iframe hides the box locally instead of recursing into its document.
  await move(...Object.values(await centerOf('#frame')));
  await waitFor(async () => (await read())?.hidden === true);

  // A stop with a hover frame still queued keeps the box hidden instead of letting the rAF draw it again.
  await move(...Object.values(await centerOf('#secret')));
  await waitFor(async () => (await read())?.hidden === false);
  await move(21, 21);
  await page.cdp.sendSession(page.sessionId, 'Runtime.evaluate', {
    contextId,
    expression: 'globalThis.__openchamberMark.stop()',
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal((await read()).hidden, true);

  off();
});

test('closes this chat\'s tabs without creating one', { skip: chromePath ? false : 'Chrome is unavailable' }, async (context) => {
  // Given a chat with no browser tab.
  const web = await startWebFixture();
  context.after(() => close(web.server));
  const runtime = createBrowserRuntime({ chromePath, allowedOrigins: [web.origin] });
  context.after(() => runtime.close());
  await assert.rejects(runtime.perform('browser.close', {}), /no tab of its own/);

  // When the chat opens two tabs, then close without an id closes the agent's newest tab.
  const first = await runtime.perform('browser.open', { url: `${web.origin}/` });
  const second = await runtime.perform('browser.open', { url: `${web.origin}/next` });
  assert.equal(runtime.tabs.length, 2);
  assert.deepEqual(await runtime.perform('browser.close', {}), { closed: true, tabId: second.tabId });
  assert.deepEqual(runtime.tabs.map((tab) => tab.id), [first.tabId]);

  // But an id from another browser is refused, and never replaced by a new tab.
  await assert.rejects(runtime.perform('browser.close', { tabId: 'missing' }), /no tab "missing"/);
  assert.equal(runtime.tabs.length, 1);

  // When the last tab closes, then the browser still accepts the next open.
  assert.deepEqual(await runtime.perform('browser.close', { tabId: first.tabId }), { closed: true, tabId: first.tabId });
  assert.equal(runtime.tabs.length, 0);
  await assert.rejects(runtime.perform('browser.close', {}), /no tab of its own/);
  const reopened = await runtime.perform('browser.open', { url: `${web.origin}/title` });
  assert.equal(reopened.title, 'Title before');
});

test('marks elements inside closed and nested shadow roots', { skip: chromePath ? false : 'Chrome is unavailable' }, async (context) => {
  // Given a page with a closed shadow root and two nested open shadow roots.
  const web = await startWebFixture();
  context.after(() => close(web.server));
  const runtime = createBrowserRuntime({ chromePath, allowedOrigins: [web.origin] });
  context.after(() => runtime.close());
  await runtime.perform('browser.open', { url: `${web.origin}/shadow` });
  const page = await runtime.ensurePage();

  // When the marker confirms over the button inside the closed root.
  await runtime.startMark('closed-shadow');
  assert.equal(await runtime.handleMarkInput({ type: 'pointer', action: 'down', button: 0, x: 90, y: 50 }, page), true);

  // Then the closed path is kept and snapshot still finds the button.
  assert.equal(runtime.markState.marks.length, 1);
  const closedMark = runtime.markState.marks[0];
  assert.equal(closedMark.tag, 'button');
  assert.ok(closedMark.shadowPath.length >= 2);
  assert.ok(closedMark.shadowPath.some((part) => part.includes('closed-btn')));
  assert.match(closedMark.name, /Closed/);

  // When the marker confirms over the button inside both nested roots.
  await runtime.startMark('nested-shadow');
  assert.equal(await runtime.handleMarkInput({ type: 'pointer', action: 'down', button: 0, x: 110, y: 155 }, page), true);

  // Then the full nested path is kept and both marks resolve.
  assert.equal(runtime.markState.marks.length, 2);
  const nestedMark = runtime.markState.marks[1];
  assert.equal(nestedMark.tag, 'button');
  assert.ok(nestedMark.shadowPath.length >= 3);
  assert.ok(nestedMark.shadowPath.some((part) => part.includes('nested-btn')));
  assert.match(nestedMark.name, /Nested/);
  const snapshot = await runtime.perform('browser.snapshot', {});
  assert.deepEqual(snapshot.marks.map((mark) => mark.resolved), [true, true]);
});

test('marks an element inside a cross-origin iframe', { skip: chromePath ? false : 'Chrome is unavailable' }, async (context) => {
  // Given a page whose iframe comes from another origin.
  const frame = await startWebFixture();
  context.after(() => close(frame.server));
  const web = await startWebFixture({ frameOrigin: frame.origin });
  context.after(() => close(web.server));
  const runtime = createBrowserRuntime({ chromePath, allowedOrigins: [web.origin, frame.origin] });
  context.after(() => runtime.close());
  await runtime.perform('browser.open', { url: `${web.origin}/cross` });
  const page = await runtime.ensurePage();
  await waitFor(async () => {
    const result = await page.cdp.sendSession(page.sessionId, 'Page.getFrameTree', {});
    return (result.frameTree?.childFrames?.length ?? 0) > 0;
  });
  const tree = await page.cdp.sendSession(page.sessionId, 'Page.getFrameTree', {});
  const childFrameId = tree.frameTree.childFrames[0].frame.id;
  const probe = await page.cdp.sendSession(page.sessionId, 'Page.createIsolatedWorld', {
    frameId: childFrameId,
    worldName: 'openchamber-test-probe',
  });
  await waitFor(async () => {
    const found = await page.cdp.sendSession(page.sessionId, 'Runtime.evaluate', {
      contextId: probe.executionContextId,
      expression: "Boolean(document.querySelector('#cross-btn'))",
      returnByValue: true,
    });
    return found?.result?.value === true;
  });

  // When the marker confirms over the button inside the cross-origin frame.
  await runtime.startMark('cross-frame');
  assert.equal(await runtime.handleMarkInput({ type: 'pointer', action: 'down', button: 0, x: 90, y: 50 }, page), true);

  // Then the frame chain is kept and snapshot resolves the inner button.
  assert.equal(runtime.markState.marks.length, 1);
  const mark = runtime.markState.marks[0];
  assert.equal(mark.tag, 'button');
  assert.deepEqual(mark.frameSelectors, ['#cross']);
  assert.match(mark.name, /Cross/);
  const snapshot = await runtime.perform('browser.snapshot', {});
  assert.equal(snapshot.marks.length, 1);
  assert.deepEqual(snapshot.marks[0].frameSelectors, ['#cross']);
  assert.equal(snapshot.marks[0].resolved, true);
});