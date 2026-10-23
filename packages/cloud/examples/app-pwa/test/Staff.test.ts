import { expect, test } from "bun:test";

// Happy DOM only; no browser, application bundle, server or database.
test("a late device poll cannot replace a newly issued pairing QR", async () => {
  const script = `
    import { strict as assert } from 'node:assert';
    const { transformAsync } = await import('./packages/ssr/node_modules/@babel/core/lib/index.js');
    const { default: solid } = await import('./packages/ssr/node_modules/babel-preset-solid/index.js');
    const { default: ts } = await import('./packages/ssr/node_modules/@babel/preset-typescript/lib/index.js');
    Bun.plugin({ name: 'staff-dom-unit', setup(builder) {
      builder.onLoad({ filter: /Staff\\.tsx$/ }, async ({ path }) => ({
        contents: (await transformAsync(await Bun.file(path).text(), { filename: path, configFile: false, babelrc: false,
          presets: [[solid, { generate: 'dom', hydratable: false }], [ts, { allExtensions: true, isTSX: true }]] })).code, loader: 'js'
      }));
    }});
    const { createDomTestHarness } = await import('./packages/ui/test/dom.ts');
    const dom = createDomTestHarness();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    const realInterval = globalThis.setInterval, realClear = globalThis.clearInterval;
    const realNow = Date.now, realUuid = crypto.randomUUID;
    Date.now = () => Date.parse('2026-10-23T10:00:00Z');
    let sequence = 0, tick;
    crypto.randomUUID = () => '20000000-0000-4000-8000-' + String(++sequence).padStart(12, '0');
    globalThis.setInterval = (callback) => { tick = callback; return 1; };
    globalThis.clearInterval = () => {};
    let dispose;
    try {
      const { createComponent } = await import('solid-js');
      const { render } = await import('solid-js/web');
      const { LocaleProvider } = await import('./packages/ui/dist/browser/index.js');
      const { default: Staff } = await import('./packages/cloud/examples/app-pwa/src/Staff.tsx');
      const a = { id: '10000000-0000-4000-8000-000000000001', name: 'Gekoppeltes iPad A', state: 'active', expiresAt: null };
      const b = { id: '10000000-0000-4000-8000-000000000002', name: 'Neues iPad B', state: 'pending', expiresAt: null };
      let pairs = 0, defer = false, release, entered, staleSignal, activeB = false;
      const statusEntered = new Promise(resolve => entered = resolve);
      const api = {
        list: async () => ({ items: [a], next: null }),
        status: async (id, signal) => {
          if (id === b.id) return { ...b, state: activeB ? 'active' : 'pending' };
          if (defer) { staleSignal = signal; entered(); return new Promise(resolve => release = resolve); }
          return a;
        },
        pair: async () => ++pairs === 1
          ? { ...a, qr: null, qrExpiresAt: '2026-10-23T10:02:00Z' }
          : { ...b, qr: 'https://cloud.example.test/app/visit-demo/counter/#cloud-app-pwa:device:' + 'A'.repeat(43), qrExpiresAt: '2026-10-23T10:02:00Z' },
        revoke: async () => {}, visit: async () => { throw new Error('unused'); }
      };
      dispose = render(() => createComponent(LocaleProvider, { locale: 'de', get children() {
        return createComponent(Staff, { initial: { items: [a], next: null }, api });
      }}), dom.root);
      const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
      const pairButton = () => [...dom.root.querySelectorAll('button')].find(button => button.textContent.trim() === 'Laden-iPad koppeln');
      pairButton().click(); await flush(); assert.equal(pairs, 1);
      defer = true; tick(); await statusEntered;
      pairButton().click(); await flush(); assert.equal(pairs, 2);
      assert.equal(staleSignal.aborted, true);
      const newQr = dom.root.querySelector('img[alt="Kopplungs-QR"]')?.getAttribute('src');
      assert.ok(newQr);
      release(a); await flush();
      assert.equal(dom.root.querySelector('img[alt="Kopplungs-QR"]')?.getAttribute('src'), newQr);
      const confirmation = () => dom.root.querySelector('[aria-label="Kopplung"]');
      assert.ok(!confirmation().textContent.includes(a.name));
      activeB = true; tick(); await flush();
      assert.equal(dom.root.querySelector('img[alt="Kopplungs-QR"]'), null);
      assert.ok(confirmation().textContent.includes('Laden-iPad gekoppelt'));
      assert.ok(confirmation().textContent.includes(b.name));
    } finally {
      dispose?.(); dom.cleanup();
      globalThis.setInterval = realInterval; globalThis.clearInterval = realClear;
      Date.now = realNow; crypto.randomUUID = realUuid;
    }
  `;
  const child = Bun.spawn([process.execPath, "--conditions=browser", "--no-env-file", "-e", script], {
    cwd: new URL("../../../../../", import.meta.url).pathname,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect({ exitCode, output: exitCode === 0 ? "" : stdout + stderr }).toEqual({ exitCode: 0, output: "" });
});
