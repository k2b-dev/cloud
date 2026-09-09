import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";

const id = "00000000-0000-4000-8000-000000000001";
const deviceId = "00000000-0000-4000-8000-000000000002";
const login = () => ({
  requestId: id,
  browserSecret: "A".repeat(43),
  comparison: "123456",
  expiresAt: new Date(Date.now() + 300_000).toISOString(),
  pollAfterSeconds: 5,
});
const pairing = () => ({
  protocol: "cloud-app-approval-v1",
  issuer: "http://localhost",
  pairingId: id,
  secret: "c".repeat(43),
  expiresAt: new Date(Date.now() + 300_000).toISOString(),
});
const start = mock(async () => Response.json(login(), { status: 202 }));
const status = mock(async () => Response.json({ state: "pending", pollAfterSeconds: 5 }));
const complete = mock(async () => new Response(null, { status: 204 }));
const pairStart = mock(async () => Response.json(pairing(), { status: 201 }));
const inspection = mock(async () => Response.json({ state: "claimed", name: "Phone", deviceId, comparison: "654321", userId: id }));
const confirm = mock(async () => Response.json({ deviceId }));
const cancel = mock(async () => new Response(null, { status: 204 }));
const update = mock(async () => new Response(null, { status: 204 }));
const list = mock(async () => Response.json({ items: [], nextCursor: null }));
const logout = mock(async () => new Response(null, { status: 204 }));
if (!isServer)
  mock.module("@valentinkolb/cloud/clients/core", () => ({
    apiClient: {
      auth: {
        logout: { $post: logout },
        "app-approval": {
          v1: {
            login: { start: { $post: start }, status: { $post: status }, complete: { $post: complete } },
            manage: {
              pairings: {
                start: { $post: pairStart },
                status: { $post: inspection },
                confirm: { $post: confirm },
                cancel: { $post: cancel },
              },
              devices: { $get: list, update: { $post: update } },
            },
          },
        },
      },
    },
  }));
const flush = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};
const button = (root: HTMLElement, label: string) =>
  Array.from(root.querySelectorAll("button")).find((item) => item.textContent?.trim() === label)!;

describe("Cloud app approval UI", () => {
  if (isServer) {
    test.skip("requires browser conditions and DOM preload", () => {});
    return;
  }
  let cleanup = () => {};
  afterEach(() => {
    cleanup();
    mock.restore();
    for (const fn of [start, status, complete, pairStart, inspection, confirm, cancel, update, list, logout]) fn.mockClear();
  });
  test("incomplete setup is visible with an admin route, not a broken pairing action", async () => {
    const dom = createDomTestHarness();
    const { default: Devices } = await import("../src/pages/app-approval/Devices.island");
    const dispose = render(
      () =>
        createComponent(Devices, {
          availability: "setup-required",
          admin: true,
          initial: { items: [], nextCursor: null },
        }),
      dom.root,
    );
    cleanup = () => {
      dispose();
      dom.cleanup();
    };
    expect(dom.root.textContent).toContain("Enabled — setup required");
    expect(dom.root.querySelector('a[href="/admin/settings?tab=user"]')).not.toBeNull();
    expect(dom.root.querySelector('a[href="/me/security/pair"]')).toBeNull();
    expect(pairStart).not.toHaveBeenCalled();
  });
  test("normal users get setup guidance without admin controls", async () => {
    const dom = createDomTestHarness();
    const { default: Devices } = await import("../src/pages/app-approval/Devices.island");
    const dispose = render(
      () =>
        createComponent(Devices, {
          availability: "setup-required",
          initial: { items: [], nextCursor: null },
        }),
      dom.root,
    );
    cleanup = () => {
      dispose();
      dom.cleanup();
    };
    expect(dom.root.textContent).toContain("Your administrator still needs");
    expect(dom.root.querySelector('a[href="/admin/settings?tab=user"]')).toBeNull();
    expect(dom.root.querySelector('a[href="/me/security/pair"]')).toBeNull();
  });
  test("installation uses the configured origin for desktop QR/copy and mobile new tabs", async () => {
    const dom = createDomTestHarness();
    const { default: InstallApp } = await import("../src/pages/app-approval/InstallApp");
    const { dialogCore, toast } = await import("@k2b/ui");
    spyOn(toast, "success").mockImplementation(() => "test");
    const origin = "http://localhost:4178";
    const copied = spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const opened = spyOn(window, "open").mockReturnValue(null);
    const dispose = render(() => createComponent(InstallApp, { origin }), dom.root);
    cleanup = () => { dispose(); dom.cleanup(); };
    button(dom.root, "Install app").click();
    await flush();
    expect(opened).not.toHaveBeenCalled();
    expect(dom.document.querySelector('img[alt="Sign-in app installation QR code"]')).not.toBeNull();
    button(dom.document.body, "Copy link").click();
    await flush();
    expect(copied).toHaveBeenCalledWith(origin);
    dialogCore.close();
    await flush();
    Object.defineProperty(navigator, "userAgent", { configurable: true, value: "Mozilla/5.0 (iPhone)" });
    button(dom.root, "Install app").click();
    expect(opened).toHaveBeenCalledWith(origin, "_blank", "noopener,noreferrer");
    expect(dom.document.querySelector("dialog[open]")).toBeNull();
  });
  test("configured setup exposes pairing while disabled setup remains discoverable to admins", async () => {
    const dom = createDomTestHarness();
    const { default: Devices } = await import("../src/pages/app-approval/Devices.island");
    let dispose = render(
      () =>
        createComponent(Devices, {
          availability: "configured",
          pairing: { userId: id, name: "Ada", appOrigin: "https://app.example" },
          initial: { items: [], nextCursor: null },
        }),
      dom.root,
    );
    cleanup = () => {
      dispose();
      dom.cleanup();
    };
    const before = dom.window.location.href;
    expect(dom.root.querySelector('a[href="/me/security/pair"]')).toBeNull();
    button(dom.root, "Pair a device").click();
    await flush();
    expect(dom.document.querySelector("dialog[open]")).not.toBeNull();
    expect(dom.window.location.href).toBe(before);
    const { dialogCore } = await import("@k2b/ui");
    dialogCore.close();
    await flush();
    expect(dom.document.querySelector("dialog[open]")).toBeNull();
    expect(dom.window.location.href).toBe(before);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(dom.window.sessionStorage.getItem(`cloud.app-pairing:${id}:${id}`)).toBeNull();
    expect(list).toHaveBeenCalledTimes(1);
    dispose();
    dom.root.replaceChildren();
    dispose = render(
      () =>
        createComponent(Devices, {
          availability: "disabled",
          admin: true,
          initial: { items: [], nextCursor: null },
        }),
      dom.root,
    );
    expect(dom.root.textContent).toContain("App sign-in disabled");
    expect(dom.root.querySelector('a[href="/admin/settings?tab=user"]')).not.toBeNull();
    expect(dom.root.querySelector('a[href="/me/security/pair"]')).toBeNull();
  });
  test("returning from identity confirmation resumes only the intended account pairing", async () => {
    const dom = createDomTestHarness();
    const { default: Devices } = await import("../src/pages/app-approval/Devices.island");
    dom.window.history.replaceState(null, "", `/me/security?reauthenticate=1&pairDevice=${id}`);
    let dispose = render(() => createComponent(Devices, {
      availability: "configured", initial: { items: [], nextCursor: null },
      pairing: { userId: deviceId, name: "Different account", appOrigin: "https://app.example" },
    }), dom.root);
    cleanup = () => { dispose(); dom.cleanup(); };
    await flush();
    expect(pairStart).not.toHaveBeenCalled();
    expect(dom.document.querySelector("dialog[open]")).toBeNull();
    dispose();
    dom.window.history.replaceState(null, "", `/me/security?reauthenticate=1&pairDevice=${id}`);
    dispose = render(() => createComponent(Devices, {
      availability: "configured", initial: { items: [], nextCursor: null },
      pairing: { userId: id, name: "Ada", appOrigin: "https://app.example" },
    }), dom.root);
    await flush();
    expect(pairStart).toHaveBeenCalledTimes(1);
    expect(dom.document.querySelector("dialog[open]")).not.toBeNull();
    expect(dom.window.location.pathname).toBe("/me/security");
    expect(dom.window.location.search).toBe("");
  });
  test("device history remains manageable when enrollment is disabled; revoke needs confirmation", async () => {
    const dom = createDomTestHarness();
    const { prompts, toast } = await import("@k2b/ui");
    const ask = spyOn(prompts, "confirm").mockResolvedValue(false);
    const success = spyOn(toast, "success").mockImplementation(() => "test");
    const { default: Devices } = await import("../src/pages/app-approval/Devices.island");
    const dispose = render(
      () =>
        createComponent(Devices, {
          availability: "disabled",
          initial: {
            nextCursor: null,
            items: [
              { id: deviceId, name: "Phone", createdAt: new Date().toISOString(), lastUsedAt: null, revokedAt: null, assisted: true },
              { id, name: "Revoked phone", createdAt: new Date().toISOString(), lastUsedAt: null, revokedAt: new Date().toISOString(), assisted: false },
            ],
          },
        }),
      dom.root,
    );
    cleanup = () => {
      dispose();
      dom.cleanup();
    };
    expect(dom.root.textContent).toContain("administrator assistance");
    expect(dom.root.textContent).not.toContain("Revoked phone");
    expect(dom.root.querySelector('a[href="/me/security/pair"]')).toBeNull();
    button(dom.root, "Revoke").click();
    await flush();
    expect(update).not.toHaveBeenCalled();
    ask.mockResolvedValue(true);
    button(dom.root, "Revoke").click();
    await flush();
    expect(update).toHaveBeenCalledTimes(1);
    expect(success).toHaveBeenCalledTimes(1);
    expect(dom.root.textContent).not.toContain("Phone");
    expect(button(dom.root, "Revoke")).toBeUndefined();
  });
  test("recent authentication errors request credentials without signing out", async () => {
    const dom = createDomTestHarness();
    const { default: Feedback } = await import("../src/pages/app-approval/Feedback");
    const { ApprovalError } = await import("../src/pages/app-approval/client");
    const dispose = render(
      () => createComponent(Feedback, { error: new ApprovalError("REAUTHENTICATE", 403), returnTo: "/me/security" }),
      dom.root,
    );
    cleanup = () => {
      dispose();
      dom.cleanup();
    };
    expect(dom.root.querySelector('[role="alert"]')).not.toBeNull();
    button(dom.root, "Confirm identity").click();
    await flush();
    expect(logout).not.toHaveBeenCalled();
    expect(dom.window.location.href).toContain("reauthenticate%3D1");
    expect(dom.window.location.href).toContain("/auth/login?redirectTo=%2Fme%2Fsecurity");
  });
  test("pairing checks show a stable loader, then a plain hint and primary footer action for the admin's own identity", async () => {
    const dom = createDomTestHarness();
    const { default: Pairing } = await import("../src/pages/app-approval/Pairing.island");
    pairStart.mockImplementationOnce(async () => Response.json({ code: "REAUTHENTICATE" }, { status: 403 }));
    const dispose = render(() => createComponent(Pairing, {
      actorId: id, userId: deviceId, name: "Another user", appOrigin: "https://app.example", returnTo: "/me/security",
    }), dom.root);
    cleanup = () => { dispose(); dom.cleanup(); };
    await flush();
    expect(dom.document.querySelector('[data-state="loading"]')).not.toBeNull();
    expect(dom.document.body.textContent).toContain("Checking identity");
    expect(button(dom.document.body, "Pair a device")).toBeUndefined();
    await Bun.sleep(75);
    expect(dom.document.querySelector('[data-state="loading"]')).not.toBeNull();
    await Bun.sleep(100);
    await flush();
    expect(dom.document.querySelector('[data-state="loading"]')).toBeNull();
    expect(dom.document.querySelector("dialog")?.classList.contains("app-pairing-dialog")).toBe(true);
    expect(dom.document.querySelector('[data-tone="warning"]')?.textContent).toContain("your own administrator identity");
    const footer = dom.document.querySelector<HTMLElement>(".k2b-panel-dialog__footer")!;
    expect(button(footer, "Confirm identity")).toBeDefined();
  });
  test("a resumed pairing without its transfer link offers a danger footer action that cancels and closes", async () => {
    const dom = createDomTestHarness();
    const { default: Pairing } = await import("../src/pages/app-approval/Pairing");
    const closed = mock(() => {});
    const key = `cloud.app-pairing:${id}:${id}`;
    dom.window.sessionStorage.setItem(key, JSON.stringify({ pairingId: id, expiresAt: pairing().expiresAt }));
    const dispose = render(() => createComponent(Pairing, {
      actorId: id, userId: id, name: "Ada", appOrigin: "https://app.example", returnTo: "/me/security", onClose: closed,
    }), dom.root);
    cleanup = () => { dispose(); dom.cleanup(); };
    await flush();
    const footer = dom.document.querySelector<HTMLElement>(".k2b-panel-dialog__footer")!;
    const abort = button(footer, "Cancel pairing");
    expect(dom.document.querySelector(".k2b-panel-dialog__header")?.textContent).toContain("Pair a device");
    expect(dom.document.querySelector(".k2b-panel-dialog__header")?.textContent).not.toContain("Ada");
    expect(abort.dataset.variant).toBe("danger");
    abort.click();
    await flush();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(closed).toHaveBeenCalledTimes(1);
    expect(dom.document.querySelector("dialog[open]")).toBeNull();
    expect(dom.window.sessionStorage.getItem(key)).toBeNull();
  });
  test("pairing transfers no secrets into storage and never confirms before explicit comparison", async () => {
    const dom = createDomTestHarness();
    const { toast } = await import("@k2b/ui");
    spyOn(toast, "success").mockImplementation(() => "test");
    const { default: Pairing } = await import("../src/pages/app-approval/Pairing.island");
    let dispose = render(
      () => createComponent(Pairing, { actorId: id, userId: id, name: "Ada", appOrigin: "https://app.example", returnTo: "/me/security" }),
      dom.root,
    );
    cleanup = () => {
      dispose();
      dom.cleanup();
    };
    expect(dom.document.querySelector("dialog[open]")).not.toBeNull();
    await flush();
    expect(dom.document.querySelector('[data-state="loading"]')).not.toBeNull();
    expect(button(dom.document.body, "Pair a device")).toBeUndefined();
    await Bun.sleep(170);
    await flush();
    expect(pairStart).toHaveBeenCalledTimes(1);
    const saved = dom.window.sessionStorage.getItem(`cloud.app-pairing:${id}:${id}`)!;
    expect(saved).toContain(id);
    expect(saved).not.toContain(pairing().secret);
    const copied = spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    button(dom.document.body, "Copy pairing link").click();
    await flush();
    const link = new URL(copied.mock.calls[0]![0]);
    expect(link.search).toBe("");
    expect(link.hash).toContain("pairing=");
    expect(dom.document.body.querySelector('a[target="_blank"]')).toBeNull();
    expect(button(dom.document.body, "Cancel pairing")).toBeUndefined();
    expect(dom.document.querySelector(".k2b-panel-dialog__footer")).toBeNull();
    expect(dom.document.body.querySelector('img[alt="Device pairing QR code"]')).not.toBeNull();
    expect(confirm).not.toHaveBeenCalled();
    dispose();
    dispose = render(
      () => createComponent(Pairing, { actorId: id, userId: id, name: "Ada", appOrigin: "https://app.example", returnTo: "/me/security" }),
      dom.root,
    );
    await flush();
    expect(dom.document.body.textContent).toContain("Pairing resumed");
    expect(dom.document.body.querySelector('a[target="_blank"]')).toBeNull();
    await Bun.sleep(5100);
    await flush();
    expect(dom.document.body.textContent).toContain("654321");
    expect(confirm).not.toHaveBeenCalled();
    expect(dom.document.body.querySelector('a[target="_blank"]')).toBeNull();
    const footer = dom.document.querySelector<HTMLElement>(".k2b-panel-dialog__footer")!;
    expect(footer).not.toBeNull();
    expect(dom.document.querySelector(".text-center .tabular-nums")?.textContent).toBe("654321");
    button(footer, "The codes match — pair device").click();
    await flush();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(dom.document.body.textContent).toContain("The device can now approve Cloud sign-ins");
    expect(dom.window.sessionStorage.getItem(`cloud.app-pairing:${id}:${id}`)).toBeNull();
  }, 15000);
  test("switching to the recovery method discards the pending browser credential", async () => {
    const dom = createDomTestHarness();
    dom.window.sessionStorage.setItem("cloud.app-login:login:/", JSON.stringify(login()));
    const { default: Login } = await import("../src/pages/auth/AppLoginForm.island");
    const dispose = render(
      () => createComponent(Login, { category: "login", fallback: { href: "/auth/login?credential=legacy", label: "Email recovery" } }),
      dom.root,
    );
    cleanup = () => {
      dispose();
      dom.cleanup();
    };
    await flush();
    const link = dom.root.querySelector<HTMLAnchorElement>('a[href="/auth/login?credential=legacy"]')!;
    expect(dom.root.querySelector('.text-center .tabular-nums')?.textContent).toBe("123456");
    expect(dom.root.textContent).not.toContain("Stopping here does not delete");
    link.addEventListener("click", (event) => event.preventDefault());
    link.click();
    await flush();
    expect(dom.window.sessionStorage.getItem("cloud.app-login:login:/")).toBeNull();
    expect(complete).not.toHaveBeenCalled();
  });
  test("expired saved login requests are discarded without contacting the server", async () => {
    const dom = createDomTestHarness();
    dom.window.sessionStorage.setItem("cloud.app-login:guest:/", JSON.stringify({ ...login(), expiresAt: "2020-01-01T00:00:00.000Z" }));
    const { default: Login } = await import("../src/pages/auth/AppLoginForm.island");
    const dispose = render(() => createComponent(Login, { category: "guest" }), dom.root);
    cleanup = () => {
      dispose();
      dom.cleanup();
    };
    await flush();
    expect(dom.window.sessionStorage.getItem("cloud.app-login:guest:/")).toBeNull();
    expect(status).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });
  test("device errors never report success or hide a still-active device", async () => {
    const dom = createDomTestHarness();
    const { prompts, toast } = await import("@k2b/ui");
    spyOn(prompts, "confirm").mockResolvedValue(true);
    const success = spyOn(toast, "success").mockImplementation(() => "test");
    update.mockImplementationOnce(async () => Response.json({ code: "REAUTHENTICATE" }, { status: 403 }));
    const { default: Devices } = await import("../src/pages/app-approval/Devices.island");
    const dispose = render(
      () =>
        createComponent(Devices, {
          availability: "configured",
          initial: {
            nextCursor: null,
            items: [
              { id: deviceId, name: "Phone", createdAt: new Date().toISOString(), lastUsedAt: null, revokedAt: null, assisted: false },
            ],
          },
        }),
      dom.root,
    );
    cleanup = () => {
      dispose();
      dom.cleanup();
    };
    button(dom.root, "Revoke").click();
    await flush();
    expect(success).not.toHaveBeenCalled();
    expect(dom.root.textContent).toContain("Confirm your identity");
    expect(button(dom.root, "Revoke")).toBeDefined();
    expect(dom.root.textContent).not.toContain("Revoked:");
  });
  test("login resumes in the originating tab and a lost completion response is never retried", async () => {
    const dom = createDomTestHarness();
    dom.window.sessionStorage.setItem("cloud.app-login:freeipa:/", JSON.stringify(login()));
    status.mockImplementationOnce(async () => Response.json({ state: "approved", pollAfterSeconds: 5 }));
    complete.mockImplementationOnce(async () => {
      throw new Error("connection lost");
    });
    const { default: Login } = await import("../src/pages/auth/AppLoginForm.island");
    let dispose = render(() => createComponent(Login, { category: "freeipa" }), dom.root);
    cleanup = () => {
      dispose();
      dom.cleanup();
    };
    await flush();
    expect(dom.root.textContent).toContain("123456");
    expect(start).not.toHaveBeenCalled();
    await Bun.sleep(5100);
    await flush();
    expect(complete).toHaveBeenCalledTimes(1);
    expect(dom.window.sessionStorage.getItem("cloud.app-login:freeipa:/")).toBeNull();
    expect(dom.root.textContent).toContain("Sign-in could not be confirmed");
    dispose();
    dispose = render(() => createComponent(Login, { category: "freeipa" }), dom.root);
    await flush();
    expect(dom.root.textContent).not.toContain("123456");
    expect(complete).toHaveBeenCalledTimes(1);
  }, 15000);
  test("an uncertain pairing confirmation is reconciled by reading, without a second confirmation write", async () => {
    const dom = createDomTestHarness();
    const { default: Pairing } = await import("../src/pages/app-approval/Pairing.island");
    dom.window.sessionStorage.setItem(`cloud.app-pairing:${id}:${id}`, JSON.stringify({ pairingId: id, expiresAt: pairing().expiresAt }));
    const dispose = render(
      () => createComponent(Pairing, { actorId: id, userId: id, name: "Ada", appOrigin: "https://app.example", returnTo: "/me/security" }),
      dom.root,
    );
    cleanup = () => {
      dispose();
      dom.cleanup();
    };
    await Bun.sleep(5100);
    await flush();
    confirm.mockImplementationOnce(async () => {
      throw new Error("lost response");
    });
    inspection.mockImplementationOnce(async () =>
      Response.json({ state: "confirmed", name: "Phone", deviceId, comparison: "654321", userId: id }),
    );
    button(dom.document.body, "The codes match — pair device").click();
    await flush();
    expect(dom.document.body.querySelector('[role="alert"]')).not.toBeNull();
    await Bun.sleep(5100);
    await flush();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(dom.document.body.querySelector('[role="alert"]')).toBeNull();
    expect(dom.document.body.textContent).toContain("The device can now approve Cloud sign-ins");
  }, 15000);
  test("foreground polling waits at least five seconds, stops while hidden, and aborts on disposal", async () => {
    const dom = createDomTestHarness();
    const { pollApproval } = await import("../src/pages/app-approval/client");
    let hidden = true;
    Object.defineProperty(dom.document, "visibilityState", { configurable: true, get: () => (hidden ? "hidden" : "visible") });
    let signal: AbortSignal | undefined;
    const read = mock(async (value: AbortSignal) => {
      signal = value;
      return true;
    });
    const stop = pollApproval(read, () => true, 0);
    cleanup = () => {
      stop();
      dom.cleanup();
    };
    expect(read).not.toHaveBeenCalled();
    await Bun.sleep(5100);
    expect(read).not.toHaveBeenCalled();
    hidden = false;
    await Bun.sleep(5100);
    expect(read).toHaveBeenCalledTimes(1);
    stop();
    expect(signal?.aborted).toBe(true);
  }, 15000);
});
