import assert from "node:assert/strict";

const origin = process.env.PWA_AUTH_URL || "http://127.0.0.1:4189";
async function get(path: string) {
  const response = await fetch(new URL(path, origin), { signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200, path);
  assert.equal(response.headers.get("referrer-policy"), "no-referrer", path);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff", path);
  return response;
}
await get("/health");
const home = await get("/");
assert.equal(home.headers.get("cache-control"), "no-store");
assert.equal(home.headers.get("x-frame-options"), "DENY");
const html = await home.text();
assert.match(html, /Cloud Login/);
const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^" ]+)"/g)].map((match) => match[1]!);
assert.ok(assets.length >= 2);
for (const path of assets) {
  const response = await get(path);
  assert.match(response.headers.get("cache-control") || "", /immutable/);
  assert.ok((await response.arrayBuffer()).byteLength > 0);
}
const manifestResponse = await get("/manifest.webmanifest");
assert.match(manifestResponse.headers.get("content-type") || "", /application\/manifest\+json/);
const manifest = await manifestResponse.json();
assert.equal(manifest.id, "/");
assert.equal(manifest.scope, "/");
assert.equal(manifest.start_url, "/");
assert.equal(manifest.display, "standalone");
for (const item of [...manifest.icons, ...manifest.screenshots]) await get(item.src);
await get("/favicon.svg");
await get("/icons/apple-touch-icon.png");
const worker = await get("/sw.js");
assert.equal(worker.headers.get("cache-control"), "no-store");
const source = await worker.text();
assert.match(source, /cloud-login-shell-/);
// Verify every precache URL, including split JS chunks omitted from HTML.
const shell = JSON.parse(source.match(/const SHELL = (\[[^;]+\]);/)![1]!);
for (const path of shell) await get(path);
for (const path of ["/missing", "/.env", "/package.json", "/scripts/serve.ts", "/%2e%2e/package.json"]) {
  assert.equal((await fetch(new URL(path, origin))).status, 404, path);
}
assert.equal((await fetch(origin, { method: "POST" })).status, 405);
const head = await fetch(origin, { method: "HEAD" });
assert.equal(head.status, 200);
assert.equal(await head.text(), "");
console.log("Production HTTP checks passed: shell, manifest, icons, screenshots, worker, caching and route isolation.");
