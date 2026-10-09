import { expect, test } from "bun:test";

// Run browser globals and the API mock in a child process so other suites keep
// their real browser/client modules.
test("push registration preserves opt-in, rebinding, disable, and failure behavior", async () => {
  const script = `
    import { mock } from "bun:test";
    import assert from "node:assert/strict";
    const calls = [];
    let subscription = null;
    let endpointFailure = false;
    let registrationFailure = false;
    const saved = {
      expirationTime: null,
      toJSON: () => ({ endpoint: "https://push.example.test/device", keys: { p256dh: "public", auth: "private" } }),
      unsubscribe: async () => { calls.push("unsubscribe"); subscription = null; return true; },
    };
    const registration = { pushManager: {
      getSubscription: async () => subscription,
      subscribe: async options => { calls.push("subscribe"); assert.equal(options.userVisibleOnly, true); subscription = saved; return saved; },
    }};
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      isSecureContext: true, PushManager: class {}, atob,
      matchMedia: () => ({ matches: false }),
    }});
    Object.defineProperty(globalThis, "Notification", { configurable: true, value: {
      permission: "default",
      requestPermission: async () => { calls.push("permission"); Notification.permission = "granted"; return "granted"; },
    }});
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: {
      userAgent: "Test", platform: "Test", maxTouchPoints: 0,
      serviceWorker: {
        register: async (path, options) => {
          calls.push("register"); assert.equal(path, "/service-worker.js"); assert.equal(options.scope, "/");
          if (registrationFailure) throw new Error("Worker failed");
          return registration;
        },
        getRegistration: async () => registration,
      },
    }});
    mock.module(${JSON.stringify(new URL("../clients/core.ts", import.meta.url).pathname)}, () => ({
      apiClient: { me: { notifications: { browser: {
        configuration: { $get: async () => { calls.push("configuration"); return Response.json({ publicKey: "AQID" }); } },
        endpoints: {
          $post: async ({ json }) => {
            calls.push("rebind"); assert.equal(json.subscription.endpoint, saved.toJSON().endpoint);
            return endpointFailure ? Response.json({ message: "Endpoint failed" }, { status: 500 }) : Response.json({});
          },
          $delete: async () => { calls.push("disable"); return Response.json({}); },
        },
      } } } },
    }));
    const { browserNotificationClient: client } = await import(${JSON.stringify(new URL("./notifications.ts", import.meta.url).pathname)});
    for (const permission of ["default", "denied"]) {
      Notification.permission = permission;
      assert.equal((await client.refreshExisting()).enabled, false);
    }
    assert.deepEqual(calls, ["register", "register"]);
    calls.length = 0;
    Notification.permission = "granted";
    assert.equal((await client.refreshExisting()).enabled, false);
    assert.deepEqual(calls, ["register"]); // No new subscription without an explicit enable.
    calls.length = 0;
    subscription = saved;
    assert.equal((await client.refreshExisting()).enabled, true);
    assert.deepEqual(calls, ["register", "rebind"]);
    calls.length = 0;
    assert.equal((await client.disable()).enabled, false);
    assert.deepEqual(calls, ["disable", "unsubscribe"]);
    calls.length = 0;
    Notification.permission = "default";
    assert.equal((await client.enable()).enabled, true);
    assert.deepEqual(calls, ["permission", "register", "configuration", "subscribe", "rebind"]);
    endpointFailure = true;
    await assert.rejects(client.refreshExisting(), /Endpoint failed/);
    endpointFailure = false;
    registrationFailure = true;
    await assert.rejects(client.refreshExisting(), /Worker failed/);
    registrationFailure = false;
    calls.length = 0;
    window.isSecureContext = false;
    assert.equal((await client.refreshExisting()).supported, false);
    assert.deepEqual(calls, []);
    delete globalThis.window;
    assert.equal((await client.state()).supported, false);
  `;
  const child = Bun.spawn([process.execPath, "--no-env-file", "-e", script], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
});

test("group closure and badges are device-local, optional, and never opt in", async () => {
  const script = `
    import { mock } from "bun:test";
    import assert from "node:assert/strict";
    mock.module(${JSON.stringify(new URL("../clients/core.ts", import.meta.url).pathname)}, () => ({ apiClient: {} }));
    const { browserNotificationClient: client } = await import(${JSON.stringify(new URL("./notifications.ts", import.meta.url).pathname)});
    const calls = [];
    const visible = [
      { tag: "inventory:stock:one", close() { calls.push(this.tag); } },
      { tag: "inventory:stock:two", close() { calls.push(this.tag); } },
      { tag: "other:stock:one", close() { calls.push(this.tag); } },
    ];
    let registration = {
      scope: "https://cloud.example/",
      getNotifications: async options => {
        calls.push(options);
        return visible.filter(item => item.tag === options.tag);
      },
    };
    const nav = {
      serviceWorker: {
        getRegistration: async scope => { assert.equal(scope, "/"); return registration; },
        register: async () => { throw new Error("Must not register"); },
      },
      setAppBadge: async count => { calls.push(["set", count]); },
      clearAppBadge: async () => { calls.push(["clear"]); },
    };
    Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { origin: "https://cloud.example" } } });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: nav });
    Object.defineProperty(globalThis, "Notification", { configurable: true, value: {
      requestPermission: async () => { throw new Error("Must not prompt"); },
    } });
    await client.closeGroup("inventory", "stock:one");
    assert.deepEqual(calls, [{ tag: "inventory:stock:one" }, "inventory:stock:one"]);
    calls.length = 0;
    await client.closeGroup("inventory", "g".repeat(128));
    assert.deepEqual(calls, [{ tag: "inventory:" + "g".repeat(128) }]);
    calls.length = 0;
    for (const [appId, group] of [
      ["", "group"], ["other:inventory", "group"], ["Inventory", "group"], ["inventory", ""],
      ["inventory", "g".repeat(129)], ["inventory", "group space"], ["inventory", "group/one"],
      ["inventory", " group"], [null, "group"], ["inventory", null],
    ]) await client.closeGroup(appId, group);
    assert.deepEqual(calls, []);
    await client.setBadge(5);
    await client.setBadge(0);
    await client.setBadge(Number.MAX_SAFE_INTEGER);
    assert.deepEqual(calls, [["set", 5], ["clear"], ["set", Number.MAX_SAFE_INTEGER]]);
    calls.length = 0;
    for (const count of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "2", null]) await client.setBadge(count);
    assert.deepEqual(calls, []);
    registration = undefined;
    await client.closeGroup("inventory", "stock:one");
    registration = { scope: "https://cloud.example/", getNotifications: undefined };
    await client.closeGroup("inventory", "stock:one");
    registration = { scope: "https://cloud.example/pwa/login", getNotifications: () => { throw new Error("Wrong worker"); } };
    await client.closeGroup("inventory", "stock:one");
    nav.serviceWorker.getRegistration = async () => { throw new Error("Unavailable"); };
    await client.closeGroup("inventory", "stock:one");
    nav.setAppBadge = async () => { throw new Error("Unavailable"); };
    nav.clearAppBadge = () => { throw new Error("Unavailable"); };
    await client.setBadge(2);
    await client.setBadge(0);
    delete nav.serviceWorker;
    delete nav.setAppBadge;
    delete nav.clearAppBadge;
    await client.closeGroup("inventory", "stock:one");
    await client.setBadge(2);
    await client.setBadge(0);
    delete globalThis.navigator;
    delete globalThis.window;
    await client.closeGroup("inventory", "stock:one");
    await client.setBadge(2);
    assert.deepEqual(calls, []);
  `;
  const child = Bun.spawn([process.execPath, "--no-env-file", "-e", script], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
});
