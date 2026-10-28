import { afterEach, describe, expect, jest, mock, spyOn, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";

const id = "00000000-0000-4000-8000-000000000001";
const deviceId = "00000000-0000-4000-8000-000000000002";
// A fixed past date for when a listed device was paired or removed; nothing compares it with today.
const pairedAt = "2026-10-01T09:00:00.000Z";
// real clock: the dialogs count these expiries down on the real clock and its timers.
const fromNow = (ms: number) => new Date(Date.now() + ms).toISOString();
const login = () => ({
  requestId: id,
  browserSecret: "A".repeat(43),
  comparison: "123456",
  expiresAt: fromNow(300_000),
  pollAfterSeconds: 5,
});
const pairing = () => ({
  protocol: "cloud-app-approval-v1",
  issuer: "http://localhost",
  pairingId: id,
  secret: "c".repeat(43),
  expiresAt: fromNow(300_000),
});
const start = mock(async () => Response.json(login(), { status: 202 }));
const status = mock(async () => Response.json({ state: "pending", pollAfterSeconds: 5 }));
const complete = mock(async () => new Response(null, { status: 204 }));
const pairStart = mock(async () => Response.json(pairing(), { status: 201 }));
const inspection = mock(async () =>
  Response.json({ state: "claimed", name: "Phone", deviceId, comparison: "654321", userId: id, approval: null }),
);
const confirm = mock(async () => Response.json({ deviceId, approval: null }));
const cancel = mock(async () => new Response(null, { status: 204 }));
const changeId = "00000000-0000-4000-8000-000000000003";
const later = () => fromNow(300_000);
const update = mock(async () => Response.json({ state: "pending", changeId, expiresAt: later() }));
const changeStatus = mock(async () => Response.json({ changeId, endSessions: true, state: "pending", expiresAt: later() }));
const changeCancel = mock(async () => new Response(null, { status: 204 }));
const list = mock(async () => Response.json({ items: [], nextCursor: null }));
const logout = mock(async () => new Response(null, { status: 204 }));
const passwordLogin = mock(async () => new Response(null, { status: 204 }));
if (!isServer)
  mock.module("@k2b/cloud/clients/core", () => ({
    apiClient: {
      auth: {
        login: { $post: passwordLogin },
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
              "device-changes": { status: { $post: changeStatus }, cancel: { $post: changeCancel } },
            },
          },
        },
      },
    },
  }));
const flush = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};
/** Waits, with a bounded deadline, for what a dialog shows after its next status read on the real five-second poll. */
const eventually = async (check: () => boolean, timeoutMs = 8_000) => {
  const deadline = performance.now() + timeoutMs;
  while (!check()) {
    if (performance.now() > deadline) throw new Error("The expected state did not appear in time");
    await Bun.sleep(50);
    await flush();
  }
};
/** The revocation phase on screen; the others stay in the dialog, hidden, to keep its size. */
const shown = (dialog: Element | null) => dialog?.querySelector(".app-revoke-phases > :not([aria-hidden])")?.textContent ?? "";
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
    for (const fn of [
      start,
      status,
      complete,
      pairStart,
      inspection,
      confirm,
      cancel,
      update,
      changeStatus,
      changeCancel,
      list,
      logout,
      passwordLogin,
    ])
      fn.mockClear();
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
    cleanup = () => {
      dispose();
      dom.cleanup();
    };
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
    let dispose = render(
      () =>
        createComponent(Devices, {
          availability: "configured",
          initial: { items: [], nextCursor: null },
          pairing: { userId: deviceId, name: "Different account", appOrigin: "https://app.example" },
        }),
      dom.root,
    );
    cleanup = () => {
      dispose();
      dom.cleanup();
    };
    await flush();
    expect(pairStart).not.toHaveBeenCalled();
    expect(dom.document.querySelector("dialog[open]")).toBeNull();
    dispose();
    dom.window.history.replaceState(null, "", `/me/security?reauthenticate=1&pairDevice=${id}`);
    dispose = render(
      () =>
        createComponent(Devices, {
          availability: "configured",
          initial: { items: [], nextCursor: null },
          pairing: { userId: id, name: "Ada", appOrigin: "https://app.example" },
        }),
      dom.root,
    );
    await flush();
    expect(pairStart).toHaveBeenCalledTimes(1);
    expect(dom.document.querySelector("dialog[open]")).not.toBeNull();
    expect(dom.window.location.pathname).toBe("/me/security");
    expect(dom.window.location.search).toBe("");
  });
  test("device history stays visible and renamable when enrollment is disabled; only a configured Cloud offers revoking", async () => {
    const dom = createDomTestHarness();
    const { default: Devices } = await import("../src/pages/app-approval/Devices.island");
    const dispose = render(
      () =>
        createComponent(Devices, {
          availability: "disabled",
          initial: {
            nextCursor: null,
            items: [
              { id: deviceId, name: "Phone", createdAt: pairedAt, lastUsedAt: null, revokedAt: null, assisted: true },
              {
                id,
                name: "Revoked phone",
                createdAt: pairedAt,
                lastUsedAt: null,
                revokedAt: pairedAt,
                assisted: false,
              },
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
    expect(button(dom.root, "Rename")).toBeDefined();
    // No paired device can approve while app sign-in is off; an administrator revokes instead.
    expect(button(dom.root, "Revoke")).toBeUndefined();
  });
  test("revoking asks a paired device, keeps the choice to end its sign-ins, and follows the request to its result", async () => {
    const dom = createDomTestHarness();
    const { default: Devices } = await import("../src/pages/app-approval/Devices.island");
    const dispose = render(
      () =>
        createComponent(Devices, {
          availability: "configured",
          pairing: { userId: id, name: "Ada", appOrigin: "https://app.example" },
          initial: {
            nextCursor: null,
            items: [{ id: deviceId, name: "Phone", createdAt: pairedAt, lastUsedAt: null, revokedAt: null, assisted: false }],
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
    const dialog = dom.document.querySelector<HTMLDialogElement>("dialog[open].app-revoke-dialog")!;
    expect(dialog).not.toBeNull();
    const choice = dialog.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(choice.checked).toBe(true);
    expect(shown(dialog)).toContain("Also end the sign-ins this device approved");
    const footer = dialog.querySelector<HTMLElement>(".k2b-panel-dialog__footer")!;
    button(footer, "Revoke").click();
    await flush();
    expect(update).toHaveBeenCalledTimes(1);
    const sent = (update.mock.calls[0] as unknown as [{ json: unknown }])[0].json;
    expect(sent).toEqual({ operation: "revoke", deviceId, endSessions: true });
    // Every phase stays in the dialog, hidden but sized, so the result never resizes it.
    expect(dialog.querySelectorAll(".app-revoke-phases > [aria-hidden]")).toHaveLength(6);
    expect(dialog.querySelector<HTMLElement>('[aria-hidden="true"] input[type="checkbox"]')).not.toBeNull();
    expect(shown(dialog)).toContain("Approve on a paired device");
    expect(button(footer, "Cancel request")).toBeDefined();
    expect(JSON.parse(dom.window.sessionStorage.getItem(`cloud.app-device-revoke:${id}`)!)).toMatchObject({
      changeId,
      deviceId,
      endSessions: true,
    });
    changeStatus.mockImplementationOnce(async () => Response.json({ changeId, endSessions: true, state: "approved", expiresAt: later() }));
    await eventually(() => shown(dialog).includes("“Phone” was revoked."));
    expect(changeStatus).toHaveBeenCalledTimes(1);
    expect(shown(dialog)).toContain("“Phone” was revoked.");
    expect(shown(dialog)).toContain("The sign-ins it approved have ended.");
    expect(dom.window.sessionStorage.getItem(`cloud.app-device-revoke:${id}`)).toBeNull();
    button(footer, "Close").click();
    await flush();
    expect(changeCancel).not.toHaveBeenCalled();
    expect(list).toHaveBeenCalledTimes(1);
  }, 15000);
  test("a reload continues a waiting revocation; a denial offers to try again; closing withdraws a waiting request", async () => {
    const dom = createDomTestHarness();
    const { default: Devices } = await import("../src/pages/app-approval/Devices.island");
    const saved = { changeId, deviceId, name: "Phone", endSessions: false, expiresAt: later() };
    dom.window.sessionStorage.setItem(`cloud.app-device-revoke:${id}`, JSON.stringify(saved));
    changeStatus.mockImplementationOnce(async () =>
      Response.json({ changeId, endSessions: false, state: "denied", expiresAt: saved.expiresAt }),
    );
    const props = {
      availability: "configured" as const,
      pairing: { userId: id, name: "Ada", appOrigin: "https://app.example" },
      initial: {
        nextCursor: null,
        items: [{ id: deviceId, name: "Phone", createdAt: pairedAt, lastUsedAt: null, revokedAt: null, assisted: false }],
      },
    };
    let dispose = render(() => createComponent(Devices, props), dom.root);
    cleanup = () => {
      dispose();
      dom.cleanup();
    };
    await Bun.sleep(30);
    await flush();
    // The resumed request is read at once, without waiting a poll interval.
    expect(changeStatus).toHaveBeenCalledTimes(1);
    let dialog = dom.document.querySelector<HTMLDialogElement>("dialog[open].app-revoke-dialog")!;
    expect(shown(dialog)).toContain("The revocation was denied on one of your devices. “Phone” stays paired.");
    let footer = dialog.querySelector<HTMLElement>(".k2b-panel-dialog__footer")!;
    button(footer, "Try again").click();
    await flush();
    expect(dialog.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(false);
    expect(button(footer, "Revoke")).toBeDefined();
    button(footer, "Revoke").click();
    await flush();
    expect(shown(dialog)).toContain("Approve on a paired device");
    button(footer, "Cancel request").click();
    await flush();
    expect(changeCancel).toHaveBeenCalledTimes(1);
    expect(dom.document.querySelector("dialog[open]")).toBeNull();
    expect(dom.window.sessionStorage.getItem(`cloud.app-device-revoke:${id}`)).toBeNull();
    dispose();
    dom.root.replaceChildren();
    // Offline, the request cannot be sent and the reason takes the place of the explanation.
    dispose = render(() => createComponent(Devices, props), dom.root);
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    try {
      button(dom.root, "Revoke").click();
      await flush();
      dialog = dom.document.querySelector<HTMLDialogElement>("dialog[open].app-revoke-dialog")!;
      footer = dialog.querySelector<HTMLElement>(".k2b-panel-dialog__footer")!;
      expect(button(footer, "Revoke").disabled).toBe(true);
      expect(dialog.querySelector('[role="status"]')?.textContent).toContain("You are offline.");
    } finally {
      Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
    }
  }, 15000);
  for (const answer of ["pending", "gone"] as const) {
    test(`a late ${answer} lookup after a reload leaves a newer removal's saved request alone`, async () => {
      const dom = createDomTestHarness();
      const { default: Devices } = await import("../src/pages/app-approval/Devices.island");
      const key = `cloud.app-device-revoke:${id}`;
      // The answer to the last send was lost, so the reload looks the request up.
      dom.window.sessionStorage.setItem(key, JSON.stringify({ deviceId, name: "Phone", endSessions: true, expiresAt: later() }));
      let respond = () => {};
      changeStatus.mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            respond = () =>
              resolve(
                answer === "pending"
                  ? Response.json({ changeId, endSessions: true, state: "pending", expiresAt: later() })
                  : Response.json({ code: "NOT_FOUND" }, { status: 404 }),
              );
          }),
      );
      const dispose = render(
        () =>
          createComponent(Devices, {
            availability: "configured",
            pairing: { userId: id, name: "Ada", appOrigin: "https://app.example" },
            initial: { nextCursor: null, items: [] },
          }),
        dom.root,
      );
      cleanup = () => {
        dispose();
        dom.cleanup();
      };
      await flush();
      expect(changeStatus).toHaveBeenCalledTimes(1);
      // Meanwhile a newer removal saved its own request for a reload.
      const newer = JSON.stringify({ changeId, deviceId, name: "Phone", endSessions: false, expiresAt: later(), owner: id });
      dom.window.sessionStorage.setItem(key, newer);
      respond();
      await Bun.sleep(30);
      await flush();
      expect(dom.window.sessionStorage.getItem(key)).toBe(newer);
      expect(dom.document.querySelector("dialog[open].app-revoke-dialog")).toBeNull();
    });
  }
  for (const state of ["approved", "denied", "expired"] as const) {
    test(`a reload ten seconds after the removal deadline reads Cloud's ${state} result`, async () => {
      const dom = createDomTestHarness();
      const { default: Devices } = await import("../src/pages/app-approval/Devices.island");
      const saved = { changeId, deviceId, name: "Phone", endSessions: true, expiresAt: fromNow(-10_000) };
      const key = `cloud.app-device-revoke:${id}`;
      dom.window.sessionStorage.setItem(key, JSON.stringify(saved));
      changeStatus.mockImplementationOnce(async () => Response.json({ changeId, endSessions: true, state, expiresAt: saved.expiresAt }));
      const dispose = render(
        () =>
          createComponent(Devices, {
            availability: "configured",
            pairing: { userId: id, name: "Ada", appOrigin: "https://app.example" },
            initial: { nextCursor: null, items: [] },
          }),
        dom.root,
      );
      cleanup = () => {
        dispose();
        dom.cleanup();
      };
      await Bun.sleep(30);
      await flush();
      expect(changeStatus).toHaveBeenCalledTimes(1);
      expect(changeStatus).toHaveBeenCalledWith({ json: { changeId } }, expect.anything());
      const dialog = dom.document.querySelector("dialog[open].app-revoke-dialog");
      const messages = {
        approved: "“Phone” was revoked.",
        denied: "The revocation was denied on one of your devices. “Phone” stays paired.",
        expired: "The request expired",
      };
      expect(shown(dialog)).toContain(messages[state]);
      expect(dom.window.sessionStorage.getItem(key)).toBeNull();
      expect(update).not.toHaveBeenCalled();
    });
  }
  for (const known of [false, true]) {
    test(`a saved removal older than the readable minute is forgotten with ${known ? "a known" : "no"} change ID`, async () => {
      const dom = createDomTestHarness();
      const { default: Devices } = await import("../src/pages/app-approval/Devices.island");
      const key = `cloud.app-device-revoke:${id}`;
      dom.window.sessionStorage.setItem(
        key,
        JSON.stringify({
          ...(known ? { changeId } : {}),
          deviceId,
          name: "Phone",
          endSessions: true,
          expiresAt: fromNow(-70_000),
        }),
      );
      const dispose = render(
        () =>
          createComponent(Devices, {
            availability: "configured",
            pairing: { userId: id, name: "Ada", appOrigin: "https://app.example" },
            initial: { nextCursor: null, items: [] },
          }),
        dom.root,
      );
      cleanup = () => {
        dispose();
        dom.cleanup();
      };
      await Bun.sleep(30);
      await flush();
      expect(dom.window.sessionStorage.getItem(key)).toBeNull();
      expect(dom.document.querySelector("dialog[open].app-revoke-dialog")).toBeNull();
      expect(changeStatus).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
      expect(list).not.toHaveBeenCalled();
    });
  }
  test("a resumed revocation that Cloud no longer keeps reads as unknown, never as expired, and can be checked again", async () => {
    const dom = createDomTestHarness();
    const { default: Devices } = await import("../src/pages/app-approval/Devices.island");
    const saved = { changeId, deviceId, name: "Phone", endSessions: true, expiresAt: fromNow(-10_000) };
    dom.window.sessionStorage.setItem(`cloud.app-device-revoke:${id}`, JSON.stringify(saved));
    changeStatus.mockImplementationOnce(async () => Response.json({ code: "UNAVAILABLE" }, { status: 404 }));
    // Trying again finds the device already revoked: Cloud says so without a new request.
    update.mockImplementationOnce(async () => Response.json({ state: "revoked" }));
    const props = {
      availability: "configured" as const,
      pairing: { userId: id, name: "Ada", appOrigin: "https://app.example" },
      initial: {
        nextCursor: null,
        items: [{ id: deviceId, name: "Phone", createdAt: pairedAt, lastUsedAt: null, revokedAt: null, assisted: false }],
      },
    };
    const dispose = render(() => createComponent(Devices, props), dom.root);
    cleanup = () => {
      dispose();
      dom.cleanup();
    };
    await Bun.sleep(30);
    await flush();
    const dialog = dom.document.querySelector<HTMLDialogElement>("dialog[open].app-revoke-dialog")!;
    expect(shown(dialog)).toContain("Cloud no longer has this request, so its result is unknown.");
    expect(shown(dialog)).not.toContain("stays paired");
    expect(dom.window.sessionStorage.getItem(`cloud.app-device-revoke:${id}`)).toBeNull();
    const footer = dialog.querySelector<HTMLElement>(".k2b-panel-dialog__footer")!;
    button(footer, "Try again").click();
    await flush();
    button(footer, "Revoke").click();
    await flush();
    expect(shown(dialog)).toContain("“Phone” was revoked.");
    expect(shown(dialog)).not.toContain("The sign-ins it approved have ended.");
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
    const dispose = render(
      () =>
        createComponent(Pairing, {
          actorId: id,
          userId: deviceId,
          name: "Another user",
          appOrigin: "https://app.example",
          returnTo: "/me/security",
          install: false,
        }),
      dom.root,
    );
    cleanup = () => {
      dispose();
      dom.cleanup();
    };
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
  test("identity confirmation returns to the pairing page with the continue marker, which the page then clears", async () => {
    const dom = createDomTestHarness();
    const { default: Pairing } = await import("../src/pages/app-approval/Pairing.island");
    const page = `/me/security/pair?userId=${deviceId}`;
    const returned = `${page}&pairDevice=${deviceId}&reauthenticate=1`;
    dom.window.history.replaceState(null, "", returned);
    pairStart.mockImplementationOnce(async () => Response.json({ code: "REAUTHENTICATE" }, { status: 403 }));
    const dispose = render(
      () =>
        createComponent(Pairing, {
          actorId: id,
          userId: deviceId,
          name: "Another user",
          appOrigin: "https://app.example",
          returnTo: `/app/accounts/users/${deviceId}`,
          install: false,
        }),
      dom.root,
    );
    cleanup = () => {
      dispose();
      dom.cleanup();
    };
    await flush();
    // A later reload or back navigation opens with the install step again.
    expect(dom.window.location.pathname + dom.window.location.search).toBe(page);
    await Bun.sleep(170);
    await flush();
    button(dom.document.querySelector<HTMLElement>(".k2b-panel-dialog__footer")!, "Confirm identity").click();
    await flush();
    // pair.page skips the install step when pairDevice names the target account.
    const login = new URL(dom.window.location.href);
    expect(login.pathname).toBe("/auth/login");
    expect(login.searchParams.get("redirectTo")).toBe(returned);
  });
  test("a resumed pairing without its transfer link offers a danger footer action that cancels and closes", async () => {
    const dom = createDomTestHarness();
    const { default: Pairing } = await import("../src/pages/app-approval/Pairing");
    const closed = mock(() => {});
    const key = `cloud.app-pairing:${id}:${id}`;
    dom.window.sessionStorage.setItem(key, JSON.stringify({ pairingId: id, expiresAt: pairing().expiresAt }));
    const dispose = render(
      () =>
        createComponent(Pairing, {
          actorId: id,
          userId: id,
          name: "Ada",
          appOrigin: "https://app.example",
          returnTo: "/me/security",
          onClose: closed,
        }),
      dom.root,
    );
    cleanup = () => {
      dispose();
      dom.cleanup();
    };
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
  test("a cancellation that Cloud does not confirm keeps the saved pairing, so opening the dialog again can cancel it", async () => {
    const dom = createDomTestHarness();
    const { toast } = await import("@k2b/ui");
    const failed = spyOn(toast, "error").mockImplementation(() => "test");
    const { default: Pairing } = await import("../src/pages/app-approval/Pairing");
    const key = `cloud.app-pairing:${id}:${id}`;
    const saved = JSON.stringify({ pairingId: id, expiresAt: pairing().expiresAt });
    dom.window.sessionStorage.setItem(key, saved);
    cancel.mockImplementationOnce(async () => new Response(null, { status: 503 }));
    const props = { actorId: id, userId: id, name: "Ada", appOrigin: "https://app.example", returnTo: "/me/security", onClose: () => {} };
    let dispose = render(() => createComponent(Pairing, props), dom.root);
    cleanup = () => {
      dispose();
      dom.cleanup();
    };
    try {
      await flush();
      button(dom.document.querySelector<HTMLElement>(".k2b-panel-dialog__footer")!, "Cancel pairing").click();
      await flush();
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(dom.document.querySelector("dialog[open]")).toBeNull();
      expect(failed).toHaveBeenCalledWith("The pairing could not be cancelled. Choose Pair a device again to cancel it.");
      expect(dom.window.sessionStorage.getItem(key)).toBe(saved);
      dispose();
      dispose = render(() => createComponent(Pairing, props), dom.root);
      await flush();
      button(dom.document.querySelector<HTMLElement>(".k2b-panel-dialog__footer")!, "Cancel pairing").click();
      await flush();
      expect(cancel).toHaveBeenCalledTimes(2);
      expect(dom.window.sessionStorage.getItem(key)).toBeNull();
    } finally {
      failed.mockRestore();
    }
  });
  test("a late cancellation answer keeps the saved reference of a newer pairing", async () => {
    const dom = createDomTestHarness();
    const { toast } = await import("@k2b/ui");
    const failed = spyOn(toast, "error").mockImplementation(() => "test");
    const { default: Pairing } = await import("../src/pages/app-approval/Pairing");
    const key = `cloud.app-pairing:${id}:${id}`;
    const newer = JSON.stringify({ pairingId: deviceId, expiresAt: pairing().expiresAt });
    const props = { actorId: id, userId: id, name: "Ada", appOrigin: "https://app.example", returnTo: "/me/security", onClose: () => {} };
    let dispose = () => {};
    cleanup = () => {
      dispose();
      dom.cleanup();
    };
    try {
      // Cloud confirms the old cancellation, or answers that the old pairing is already gone.
      for (const answer of [204, 404]) {
        dom.window.sessionStorage.setItem(key, JSON.stringify({ pairingId: id, expiresAt: pairing().expiresAt }));
        let respond = () => {};
        cancel.mockImplementationOnce(
          () =>
            new Promise<Response>((resolve) => {
              respond = () =>
                resolve(answer === 204 ? new Response(null, { status: 204 }) : Response.json({ code: "NOT_FOUND" }, { status: 404 }));
            }),
        );
        dispose = render(() => createComponent(Pairing, props), dom.root);
        await flush();
        button(dom.document.querySelector<HTMLElement>(".k2b-panel-dialog__footer")!, "Cancel pairing").click();
        await flush();
        // Meanwhile a newer pairing saved its own reference for a reload.
        dom.window.sessionStorage.setItem(key, newer);
        respond();
        await flush();
        expect(dom.window.sessionStorage.getItem(key)).toBe(newer);
        dispose();
      }
    } finally {
      failed.mockRestore();
    }
  });
  test("assisted pairing starts with the app installation and creates the pairing only after Next", async () => {
    const dom = createDomTestHarness();
    const { toast } = await import("@k2b/ui");
    const success = spyOn(toast, "success").mockImplementation(() => "test");
    const copied = spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const { default: Pairing } = await import("../src/pages/app-approval/Pairing.island");
    const dispose = render(
      () =>
        createComponent(Pairing, {
          actorId: id,
          userId: deviceId,
          name: "Another user",
          appOrigin: "https://app.example",
          returnTo: `/app/accounts/users/${deviceId}`,
          install: true,
        }),
      dom.root,
    );
    cleanup = () => {
      dispose();
      dom.cleanup();
    };
    await Bun.sleep(20); // the dialog's initial focus runs on the next frame
    await flush();
    const body = dom.document.body;
    const heading = body.querySelector<HTMLElement>(".k2b-panel-dialog__body h3")!;
    expect(heading.textContent).toContain("Step 1 of 2");
    expect(heading.textContent).toContain("Install the sign-in app");
    expect(body.querySelector('img[alt="Sign-in app installation QR code"]')).not.toBeNull();
    expect(body.querySelector('img[alt="Device pairing QR code"]')).toBeNull();
    expect(body.querySelector('[data-tone="warning"]')).toBeNull();
    expect(pairStart).not.toHaveBeenCalled();
    button(body, "Copy link").click();
    await flush();
    expect(copied).toHaveBeenCalledWith("https://app.example");
    expect(success).toHaveBeenCalledWith("App link copied");
    const footer = body.querySelector<HTMLElement>(".k2b-panel-dialog__footer")!;
    expect(button(footer, "App is already installed").dataset.variant).toBe("secondary");
    button(footer, "Next").click();
    await flush();
    expect(pairStart).toHaveBeenCalledTimes(1);
    const focused = dom.document.activeElement as HTMLElement;
    expect(focused.tagName).toBe("H3");
    expect(focused.textContent).toContain("Step 2 of 2");
    expect(focused.textContent).toContain("Connect the app");
    expect(body.querySelector('[data-state="loading"]')).not.toBeNull();
    await Bun.sleep(170);
    await flush();
    expect(body.querySelector('img[alt="Sign-in app installation QR code"]')).toBeNull();
    expect(body.querySelector('img[alt="Device pairing QR code"]')).not.toBeNull();
    expect(body.querySelector('[data-tone="warning"]')?.textContent).toContain("Pair only together with the user");
    expect(dom.document.activeElement).toBe(focused);
  });
  test("the install step can be closed or skipped and never delays a pairing that is already running", async () => {
    const dom = createDomTestHarness();
    const { dialogCore } = await import("@k2b/ui");
    const { default: Pairing } = await import("../src/pages/app-approval/Pairing");
    const closed = mock(() => {});
    const props = {
      actorId: id,
      userId: id,
      name: "Ada",
      appOrigin: "https://app.example",
      returnTo: "/me/security",
      install: true,
      onClose: closed,
    };
    let dispose = render(() => createComponent(Pairing, props), dom.root);
    cleanup = () => {
      dispose();
      dom.cleanup();
    };
    await flush();
    const protectedDialog = dom.document.querySelector("dialog")!;
    protectedDialog.dispatchEvent(new Event("cancel", { cancelable: true }));
    protectedDialog.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    protectedDialog.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
    expect(dialogCore.isOpen()).toBe(true);
    expect(closed).not.toHaveBeenCalled();
    dialogCore.close();
    await flush();
    expect(closed).toHaveBeenCalledTimes(1);
    expect(pairStart).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    dispose();
    dispose = render(() => createComponent(Pairing, props), dom.root);
    await flush();
    button(dom.document.body, "App is already installed").click();
    await flush();
    expect(pairStart).toHaveBeenCalledTimes(1);
    expect(dom.document.activeElement?.textContent).toContain("Connect the app");
    dispose();
    dom.window.sessionStorage.setItem(`cloud.app-pairing:${id}:${id}`, JSON.stringify({ pairingId: id, expiresAt: pairing().expiresAt }));
    dispose = render(() => createComponent(Pairing, props), dom.root);
    await flush();
    expect(dom.document.body.textContent).toContain("Pairing resumed");
    expect(dom.document.body.textContent).not.toContain("Step 1 of 2");
    expect(dom.document.body.textContent).not.toContain("Step 2 of 2");
    expect(pairStart).toHaveBeenCalledTimes(1);
  });
  test("a failed pairing start stays open and offers an explicit retry", async () => {
    const dom = createDomTestHarness();
    const { default: Pairing } = await import("../src/pages/app-approval/Pairing");
    pairStart.mockImplementationOnce(async () => {
      throw new Error("Network interrupted");
    });
    const dispose = render(
      () =>
        createComponent(Pairing, {
          actorId: id,
          userId: id,
          name: "Ada",
          appOrigin: "https://app.example",
          returnTo: "/me/security",
          onClose: () => {},
        }),
      dom.root,
    );
    cleanup = () => {
      dispose();
      dom.cleanup();
    };
    await Bun.sleep(170);
    await flush();
    expect(dom.document.querySelector("dialog[open]")).not.toBeNull();
    expect(button(dom.document.body, "Try again")).toBeDefined();
    // The retry enters loading without closing the dialog or requiring another page visit.
    button(dom.document.body, "Try again").click();
    await flush();
    expect(pairStart).toHaveBeenCalledTimes(2);
    expect(dom.document.querySelector('[data-state="loading"]')).not.toBeNull();
  });
  test("pairing transfers no secrets into storage and never confirms before explicit comparison", async () => {
    const dom = createDomTestHarness();
    const { toast } = await import("@k2b/ui");
    spyOn(toast, "success").mockImplementation(() => "test");
    const { default: Pairing } = await import("../src/pages/app-approval/Pairing.island");
    let dispose = render(
      () =>
        createComponent(Pairing, {
          actorId: id,
          userId: id,
          name: "Ada",
          appOrigin: "https://app.example",
          returnTo: "/me/security",
          install: false,
        }),
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
      () =>
        createComponent(Pairing, {
          actorId: id,
          userId: id,
          name: "Ada",
          appOrigin: "https://app.example",
          returnTo: "/me/security",
          install: false,
        }),
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
    expect(dom.root.querySelector(".text-center .tabular-nums")?.textContent).toBe("123456");
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
    const { toast } = await import("@k2b/ui");
    const success = spyOn(toast, "success").mockImplementation(() => "test");
    update.mockImplementationOnce(async () => Response.json({ code: "REAUTHENTICATE" }, { status: 403 }));
    const { default: Devices } = await import("../src/pages/app-approval/Devices.island");
    const dispose = render(
      () =>
        createComponent(Devices, {
          availability: "configured",
          pairing: { userId: id, name: "Ada", appOrigin: "https://app.example" },
          initial: {
            nextCursor: null,
            items: [{ id: deviceId, name: "Phone", createdAt: pairedAt, lastUsedAt: null, revokedAt: null, assisted: false }],
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
    const dialog = dom.document.querySelector<HTMLDialogElement>("dialog[open].app-revoke-dialog")!;
    const footer = dialog.querySelector<HTMLElement>(".k2b-panel-dialog__footer")!;
    button(footer, "Revoke").click();
    await flush();
    expect(success).not.toHaveBeenCalled();
    expect(shown(dialog)).toContain("Confirm your identity");
    expect(button(footer, "Try again")).toBeDefined();
    expect(dom.window.sessionStorage.getItem(`cloud.app-device-revoke:${id}`)).toBeNull();
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
      () =>
        createComponent(Pairing, {
          actorId: id,
          userId: id,
          name: "Ada",
          appOrigin: "https://app.example",
          returnTo: "/me/security",
          install: false,
        }),
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
      Response.json({ state: "confirmed", name: "Phone", deviceId, comparison: "654321", userId: id, approval: null }),
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
  test("a revocation sent while the dialog closes is withdrawn, and a failed withdrawal keeps the request for a reload", async () => {
    const dom = createDomTestHarness();
    const { toast } = await import("@k2b/ui");
    const failed = spyOn(toast, "error").mockImplementation(() => "test");
    const { default: Devices } = await import("../src/pages/app-approval/Devices.island");
    const props = {
      availability: "configured" as const,
      pairing: { userId: id, name: "Ada", appOrigin: "https://app.example" },
      initial: {
        nextCursor: null,
        items: [{ id: deviceId, name: "Phone", createdAt: pairedAt, lastUsedAt: null, revokedAt: null, assisted: false }],
      },
    };
    const dispose = render(() => createComponent(Devices, props), dom.root);
    cleanup = () => {
      dispose();
      dom.cleanup();
    };
    const sent = Promise.withResolvers<Response>();
    update.mockImplementationOnce(() => sent.promise);
    // The list reloads after the dialog closes; the device is still paired.
    list.mockImplementationOnce(async () => Response.json(props.initial));
    button(dom.root, "Revoke").click();
    await flush();
    const footer = () => dom.document.querySelector<HTMLElement>("dialog[open].app-revoke-dialog .k2b-panel-dialog__footer")!;
    button(footer(), "Revoke").click();
    await flush();
    const { dialogCore } = await import("@k2b/ui");
    dialogCore.close();
    await flush();
    // Until the answer arrives, a reload could still find the request through the saved record.
    expect(JSON.parse(dom.window.sessionStorage.getItem(`cloud.app-device-revoke:${id}`)!).deviceId).toBe(deviceId);
    sent.resolve(Response.json({ state: "pending", changeId, expiresAt: later() }));
    await flush();
    expect(changeCancel).toHaveBeenCalledTimes(1);
    expect(dom.window.sessionStorage.getItem(`cloud.app-device-revoke:${id}`)).toBeNull();
    // Offline or failing, Cancel request leaves the saved request, so the page shows it again after a reload.
    button(dom.root, "Revoke").click();
    await flush();
    button(footer(), "Revoke").click();
    await flush();
    changeCancel.mockImplementationOnce(async () => {
      throw new TypeError("offline");
    });
    button(footer(), "Cancel request").click();
    await flush();
    expect(changeCancel).toHaveBeenCalledTimes(2);
    expect(failed).toHaveBeenCalledTimes(1);
    expect(JSON.parse(dom.window.sessionStorage.getItem(`cloud.app-device-revoke:${id}`)!).changeId).toBe(changeId);
  });
  test("a late revocation of a closed dialog is withdrawn when a newer dialog for the device follows another request", async () => {
    const dom = createDomTestHarness();
    const { default: Devices } = await import("../src/pages/app-approval/Devices.island");
    const props = {
      availability: "configured" as const,
      pairing: { userId: id, name: "Ada", appOrigin: "https://app.example" },
      initial: {
        nextCursor: null,
        items: [{ id: deviceId, name: "Phone", createdAt: pairedAt, lastUsedAt: null, revokedAt: null, assisted: false }],
      },
    };
    const dispose = render(() => createComponent(Devices, props), dom.root);
    cleanup = () => {
      dispose();
      dom.cleanup();
    };
    const late = "00000000-0000-4000-8000-000000000013",
      newer = "00000000-0000-4000-8000-000000000014";
    const sent = Promise.withResolvers<Response>();
    update.mockImplementationOnce(() => sent.promise);
    update.mockImplementationOnce(async () => Response.json({ state: "pending", changeId: newer, expiresAt: later() }));
    list.mockImplementation(async () => Response.json(props.initial));
    const dialog = () => dom.document.querySelector<HTMLElement>("dialog[open].app-revoke-dialog")!;
    const footer = () => dialog().querySelector<HTMLElement>(".k2b-panel-dialog__footer")!;
    button(dom.root, "Revoke").click();
    await flush();
    button(footer(), "Revoke").click();
    await flush();
    const { dialogCore } = await import("@k2b/ui");
    dialogCore.close();
    await flush();
    // A newer dialog asks with the other choice, and Cloud answers it before the first send.
    button(dom.root, "Revoke").click();
    await flush();
    dialog().querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
    await flush();
    button(footer(), "Revoke").click();
    await flush();
    expect(JSON.parse(dom.window.sessionStorage.getItem(`cloud.app-device-revoke:${id}`)!)).toMatchObject({
      changeId: newer,
      endSessions: false,
    });
    // The first send commits last; Cloud replaced the newer request with it, which nobody follows.
    sent.resolve(Response.json({ state: "pending", changeId: late, expiresAt: later() }));
    await flush();
    expect(changeCancel).toHaveBeenCalledTimes(1);
    expect((changeCancel.mock.calls[0] as unknown[] | undefined)?.[0]).toEqual({ json: { changeId: late } });
    expect(JSON.parse(dom.window.sessionStorage.getItem(`cloud.app-device-revoke:${id}`)!).changeId).toBe(newer);
  });
  test("closing after a lost revocation answer finds the request Cloud may have created and withdraws it", async () => {
    const dom = createDomTestHarness();
    const { default: Devices } = await import("../src/pages/app-approval/Devices.island");
    const dispose = render(
      () =>
        createComponent(Devices, {
          availability: "configured",
          pairing: { userId: id, name: "Ada", appOrigin: "https://app.example" },
          initial: {
            nextCursor: null,
            items: [{ id: deviceId, name: "Phone", createdAt: pairedAt, lastUsedAt: null, revokedAt: null, assisted: false }],
          },
        }),
      dom.root,
    );
    cleanup = () => {
      dispose();
      dom.cleanup();
    };
    update.mockImplementationOnce(async () => {
      throw new TypeError("connection lost");
    });
    button(dom.root, "Revoke").click();
    await flush();
    const footer = dom.document.querySelector<HTMLElement>("dialog[open].app-revoke-dialog .k2b-panel-dialog__footer")!;
    button(footer, "Revoke").click();
    await flush();
    expect(button(footer, "Try again")).toBeDefined();
    button(footer, "Close").click();
    await flush();
    await flush();
    // Nothing is sent again: the browser reads which request Cloud kept for this session and withdraws it.
    expect(update).toHaveBeenCalledTimes(1);
    expect((changeStatus.mock.calls.at(-1) as unknown as [{ json: unknown }])[0].json).toEqual({ deviceId });
    expect(changeCancel).toHaveBeenCalledTimes(1);
    expect(dom.window.sessionStorage.getItem(`cloud.app-device-revoke:${id}`)).toBeNull();
  });
  test("a status read that first learns of the approval request keeps the pairing for a reload until that request ends", async () => {
    const dom = createDomTestHarness();
    const { default: Pairing } = await import("../src/pages/app-approval/Pairing.island");
    dom.window.sessionStorage.setItem(`cloud.app-pairing:${id}:${id}`, JSON.stringify({ pairingId: id, expiresAt: pairing().expiresAt }));
    const until = fromNow(600_000);
    inspection.mockImplementationOnce(async () =>
      Response.json({
        state: "claimed",
        name: "Phone",
        deviceId,
        comparison: "654321",
        userId: id,
        approval: { state: "pending", expiresAt: until },
      }),
    );
    const dispose = render(
      () =>
        createComponent(Pairing, {
          actorId: id,
          userId: id,
          name: "Ada",
          appOrigin: "https://app.example",
          returnTo: "/me/security",
          install: false,
        }),
      dom.root,
    );
    cleanup = () => {
      dispose();
      dom.cleanup();
    };
    await eventually(() => JSON.parse(dom.window.sessionStorage.getItem(`cloud.app-pairing:${id}:${id}`)!).expiresAt === until);
    expect(dom.document.body.textContent).toContain("Approve on a paired device");
  }, 15000);
  test("a reload after a lost revocation answer reopens the request once Cloud holds one for this session, also after an empty lookup", async () => {
    const dom = createDomTestHarness();
    const { default: Devices } = await import("../src/pages/app-approval/Devices.island");
    const key = `cloud.app-device-revoke:${id}`;
    const props = {
      availability: "configured" as const,
      pairing: { userId: id, name: "Ada", appOrigin: "https://app.example" },
      initial: {
        nextCursor: null,
        items: [{ id: deviceId, name: "Phone", createdAt: pairedAt, lastUsedAt: null, revokedAt: null, assisted: false }],
      },
    };
    dom.window.sessionStorage.setItem(key, JSON.stringify({ deviceId, name: "Phone", endSessions: true, expiresAt: fromNow(-10_000) }));
    let dispose = render(() => createComponent(Devices, props), dom.root);
    cleanup = () => {
      dispose();
      dom.cleanup();
    };
    await flush();
    await Bun.sleep(20);
    await flush();
    expect((changeStatus.mock.calls[0] as unknown as [{ json: unknown }])[0].json).toEqual({ deviceId });
    expect(shown(dom.document.querySelector("dialog[open].app-revoke-dialog"))).toContain("Approve on a paired device");
    expect(JSON.parse(dom.window.sessionStorage.getItem(key)!).changeId).toBe(changeId);
    const { dialogCore } = await import("@k2b/ui");
    dialogCore.close();
    await flush();
    dispose();
    dom.root.replaceChildren();
    const saved = JSON.stringify({ deviceId, name: "Phone", endSessions: true, expiresAt: later() });
    dom.window.sessionStorage.setItem(key, saved);
    changeStatus.mockImplementationOnce(async () => Response.json({ code: "UNAVAILABLE" }, { status: 404 }));
    dispose = render(() => createComponent(Devices, props), dom.root);
    await flush();
    await Bun.sleep(20);
    await flush();
    expect(dom.document.querySelector("dialog[open]")).toBeNull();
    expect(dom.window.sessionStorage.getItem(key)).toBe(saved);
    // The held-up send commits after the empty lookup; the next reload finds it.
    dispose();
    dom.root.replaceChildren();
    changeStatus.mockImplementationOnce(async () => Response.json({ changeId, endSessions: true, state: "pending", expiresAt: later() }));
    dispose = render(() => createComponent(Devices, props), dom.root);
    await flush();
    await Bun.sleep(20);
    await flush();
    expect(shown(dom.document.querySelector("dialog[open].app-revoke-dialog"))).toContain("Approve on a paired device");
    expect(JSON.parse(dom.window.sessionStorage.getItem(key)!).changeId).toBe(changeId);
  });
  test("a saved pairing past its deadline asks Cloud first and starts over only when Cloud no longer has it", async () => {
    const dom = createDomTestHarness();
    const { default: Pairing } = await import("../src/pages/app-approval/Pairing.island");
    dom.window.sessionStorage.setItem(`cloud.app-pairing:${id}:${id}`, JSON.stringify({ pairingId: id, expiresAt: fromNow(-1_000) }));
    inspection.mockImplementationOnce(async () => Response.json({ code: "UNAVAILABLE" }, { status: 404 }));
    const dispose = render(
      () =>
        createComponent(Pairing, {
          actorId: id,
          userId: id,
          name: "Ada",
          appOrigin: "https://app.example",
          returnTo: "/me/security",
          install: false,
        }),
      dom.root,
    );
    cleanup = () => {
      dispose();
      dom.cleanup();
    };
    await Bun.sleep(30);
    await flush();
    // Read at once, without waiting a poll interval; then a new pairing starts.
    expect(inspection).toHaveBeenCalledTimes(1);
    await Bun.sleep(200);
    await flush();
    expect(pairStart).toHaveBeenCalledTimes(1);
  });
  test("a device that was revoked meanwhile reads as revoked without claiming that its sign-ins ended", async () => {
    const dom = createDomTestHarness();
    const { default: Devices } = await import("../src/pages/app-approval/Devices.island");
    const dispose = render(
      () =>
        createComponent(Devices, {
          availability: "configured",
          pairing: { userId: id, name: "Ada", appOrigin: "https://app.example" },
          initial: {
            nextCursor: null,
            items: [{ id: deviceId, name: "Phone", createdAt: pairedAt, lastUsedAt: null, revokedAt: null, assisted: false }],
          },
        }),
      dom.root,
    );
    cleanup = () => {
      dispose();
      dom.cleanup();
    };
    update.mockImplementationOnce(async () => Response.json({ state: "revoked" }));
    button(dom.root, "Revoke").click();
    await flush();
    const dialog = dom.document.querySelector<HTMLDialogElement>("dialog[open].app-revoke-dialog")!;
    button(dialog.querySelector<HTMLElement>(".k2b-panel-dialog__footer")!, "Revoke").click();
    await flush();
    expect(shown(dialog)).toContain("“Phone” was revoked.");
    expect(shown(dialog)).not.toContain("The sign-ins it approved have ended.");
    expect(dom.window.sessionStorage.getItem(`cloud.app-device-revoke:${id}`)).toBeNull();
  });
  test("a pairing on an account with a paired device waits for its approval in the place of the code and shows a denial", async () => {
    const dom = createDomTestHarness();
    const { toast } = await import("@k2b/ui");
    const success = spyOn(toast, "success").mockImplementation(() => "test");
    const { default: Pairing } = await import("../src/pages/app-approval/Pairing.island");
    dom.window.sessionStorage.setItem(`cloud.app-pairing:${id}:${id}`, JSON.stringify({ pairingId: id, expiresAt: pairing().expiresAt }));
    const dispose = render(
      () =>
        createComponent(Pairing, {
          actorId: id,
          userId: id,
          name: "Ada",
          appOrigin: "https://app.example",
          returnTo: "/me/security",
          install: false,
        }),
      dom.root,
    );
    cleanup = () => {
      dispose();
      dom.cleanup();
    };
    const footer = dom.document.querySelector<HTMLElement>(".k2b-panel-dialog__footer")!;
    await eventually(() => !!button(footer, "The codes match — pair device"));
    const expiresAt = fromNow(600_000);
    confirm.mockImplementationOnce(async () => Response.json({ deviceId, approval: { state: "pending", expiresAt } }));
    button(footer, "The codes match — pair device").click();
    await flush();
    expect(success).not.toHaveBeenCalled();
    expect(dom.document.body.textContent).toContain("Approve on a paired device");
    expect(dom.document.body.textContent).toContain("approve “Phone”. Nothing is paired until then.");
    // The code keeps its place, hidden, so the wait has the same size.
    const code = dom.document.querySelector(".text-center .tabular-nums")!.closest<HTMLElement>("[aria-hidden]")!;
    expect(code.getAttribute("aria-hidden")).toBe("true");
    expect(code.hasAttribute("inert")).toBe(true);
    expect(button(footer, "The codes match — pair device")).toBeUndefined();
    expect(button(footer, "Cancel pairing")).toBeDefined();
    // A reload continues until the request on the paired device ends.
    expect(JSON.parse(dom.window.sessionStorage.getItem(`cloud.app-pairing:${id}:${id}`)!).expiresAt).toBe(expiresAt);
    inspection.mockImplementationOnce(async () =>
      Response.json({
        state: "cancelled",
        name: "Phone",
        deviceId,
        comparison: "654321",
        userId: id,
        approval: { state: "denied", expiresAt },
      }),
    );
    await eventually(
      () => !!dom.document.body.textContent?.includes("The pairing was denied on one of your paired devices. Nothing was paired."),
    );
    expect(dom.document.querySelector("dialog[open]")).not.toBeNull();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(dom.window.sessionStorage.getItem(`cloud.app-pairing:${id}:${id}`)).toBeNull();
  }, 20000);
  test("foreground reads start at least five seconds apart, pause while hidden, and abort on disposal", async () => {
    jest.useFakeTimers();
    const dom = createDomTestHarness();
    const { pollApproval } = await import("../src/pages/app-approval/client");
    let hidden = true;
    Object.defineProperty(dom.document, "visibilityState", { configurable: true, get: () => (hidden ? "hidden" : "visible") });
    let signal: AbortSignal | undefined;
    let answer = (_again: boolean) => {};
    const starts: number[] = [];
    const t0 = Date.now();
    const read = mock((value: AbortSignal) => {
      signal = value;
      starts.push(Date.now() - t0);
      return new Promise<boolean>((resolve) => {
        answer = resolve;
      });
    });
    const stop = pollApproval(read, () => true, 0);
    cleanup = () => {
      stop();
      dom.cleanup();
      jest.useRealTimers();
    };
    jest.advanceTimersByTime(10_000);
    expect(read).not.toHaveBeenCalled();
    hidden = false;
    dom.document.dispatchEvent(new dom.window.Event("visibilitychange") as unknown as Event);
    jest.advanceTimersByTime(1); // zero-delay timers take one millisecond
    expect(starts).toEqual([10_001]);
    // A read the server held for a full interval is followed at once.
    jest.advanceTimersByTime(5_000);
    answer(true);
    await flush();
    jest.advanceTimersByTime(1);
    expect(starts).toEqual([10_001, 15_002]);
    // A quick answer waits for the rest of the interval.
    jest.advanceTimersByTime(1_000);
    answer(true);
    await flush();
    jest.advanceTimersByTime(3_999);
    expect(starts).toHaveLength(2);
    jest.advanceTimersByTime(1);
    expect(starts).toEqual([10_001, 15_002, 20_002]);
    stop();
    expect(signal?.aborted).toBe(true);
  });
  test("an approval continues at once and the form never returns before navigation", async () => {
    jest.useFakeTimers();
    const dom = createDomTestHarness();
    const t0 = Date.now();
    dom.window.sessionStorage.setItem("cloud.app-login:login:/app/files", JSON.stringify(login()));
    let decide = (_response: Response) => {};
    status.mockImplementation(
      // Long poll: the server answers when the app decides.
      () =>
        new Promise<Response>((resolve) => {
          decide = resolve;
        }),
    );
    let navigatedAt: number | undefined;
    const assign = spyOn(dom.window.location, "assign").mockImplementation(() => {
      navigatedAt = Date.now() - t0;
    });
    const forms: Node[] = [];
    const observer = new dom.window.MutationObserver((records) => {
      for (const record of records)
        for (const node of record.addedNodes)
          if (node.nodeName === "FORM" || (node as unknown as Element).querySelector?.("form")) forms.push(node as unknown as Node);
    });
    const { default: Login } = await import("../src/pages/auth/AppLoginForm.island");
    const dispose = render(
      () =>
        createComponent(Login, {
          category: "login",
          redirectTo: "/app/files",
          fallback: { href: "/auth/login?credential=legacy", label: "Email recovery" },
        }),
      dom.root,
    );
    cleanup = () => {
      observer.disconnect();
      dispose();
      dom.cleanup();
      jest.useRealTimers();
    };
    await flush();
    expect(dom.root.textContent).toContain("123456");
    observer.observe(dom.root, { childList: true, subtree: true });
    jest.advanceTimersByTime(1);
    expect(status).toHaveBeenCalledTimes(1);
    // The app approves two seconds later; no further read or timer is needed to continue.
    jest.advanceTimersByTime(2_000);
    const decidedAt = Date.now() - t0;
    decide(Response.json({ state: "approved", pollAfterSeconds: 5 }));
    await flush();
    expect(complete).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith("/auth/continue?redirectTo=%2Fapp%2Ffiles");
    expect(navigatedAt).toBe(decidedAt);
    // Navigation takes its time; the page keeps the confirmed state meanwhile.
    jest.advanceTimersByTime(30_000);
    await flush();
    expect(dom.root.querySelector("form")).toBeNull();
    expect(forms).toEqual([]);
    expect(dom.root.textContent).toContain("Signed in – continuing…");
    expect(dom.root.textContent).not.toContain("Email recovery");
    expect(status).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledTimes(1);
  });
  test.each([
    ["freeipa", ["login_freeipa_app=1", "login_method=ipa"], true],
    ["login", ["login_method=login"], true],
    ["guest", ["login_method=guest"], false],
  ] as const)("a completed %s app sign-in reopens that account type next time", async (category, remembered, withApp) => {
    const dom = createDomTestHarness();
    dom.window.sessionStorage.setItem(`cloud.app-login:${category}:/`, JSON.stringify(login()));
    status.mockImplementationOnce(async () => Response.json({ state: "approved", pollAfterSeconds: 5 }));
    const assign = spyOn(dom.window.location, "assign").mockImplementation(() => {});
    const { default: Login } = await import("../src/pages/auth/AppLoginForm.island");
    const { useAppSignIn } = await import("../src/pages/app-approval/availability");
    const { readLoginMethodFromCookieHeader } = await import("@k2b/cloud/shared");
    const { DEFAULT_ACCOUNT_CATEGORY_POLICY, resolveAccountCategoryLogin } = await import("@k2b/cloud/contracts");
    const dispose = render(() => createComponent(Login, { category }), dom.root);
    cleanup = () => {
      dispose();
      dom.cleanup();
    };
    await Bun.sleep(20); // the first status read starts on a zero-delay timer
    await flush();
    expect(complete).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledTimes(1);
    // Only FreeIPA keeps a memory of the app, and no cookie names an account.
    const cookieHeader = dom.document.cookie;
    expect(cookieHeader.split("; ").sort()).toEqual([...remembered]);
    // The next request carries these cookies; the sign-in page resolves them like this.
    const { active } = resolveAccountCategoryLogin({
      policy: DEFAULT_ACCOUNT_CATEGORY_POLICY,
      freeIpaEnabled: true,
      remembered: readLoginMethodFromCookieHeader(cookieHeader),
    });
    expect(active).toBe(category);
    expect(useAppSignIn({ configured: true, category: active, cookieHeader })).toBe(withApp);
  });
  test("a lost or denied app sign-in remembers nothing", async () => {
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
    await Bun.sleep(20);
    await flush();
    expect(complete).toHaveBeenCalledTimes(1);
    expect(dom.document.cookie).toBe("");
    dispose();
    dom.window.sessionStorage.setItem("cloud.app-login:freeipa:/", JSON.stringify(login()));
    status.mockImplementationOnce(async () => Response.json({ state: "denied", pollAfterSeconds: 5 }));
    dispose = render(() => createComponent(Login, { category: "freeipa" }), dom.root);
    await Bun.sleep(20);
    await flush();
    expect(dom.root.textContent).toContain("Sign-in was declined");
    expect(dom.document.cookie).toBe("");
  });
  test("a FreeIPA password sign-in returns the browser to the password; a rejected one changes nothing", async () => {
    const dom = createDomTestHarness();
    const { FREEIPA_APP_SIGN_IN_COOKIE, useAppSignIn } = await import("../src/pages/app-approval/availability");
    const { default: PasswordLogin } = await import("../src/pages/auth/LoginForm.island");
    const opensWithApp = () => useAppSignIn({ configured: true, category: "freeipa", cookieHeader: dom.document.cookie });
    dom.document.cookie = `${FREEIPA_APP_SIGN_IN_COOKIE}=1; path=/`;
    expect(opensWithApp()).toBe(true);
    const dispose = render(() => createComponent(PasswordLogin, { defaultUsername: "mira" }), dom.root);
    cleanup = () => {
      dispose();
      dom.cleanup();
    };
    const submit = async () => {
      dom.root
        .querySelector("form")!
        .dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event);
      await flush();
    };
    passwordLogin.mockImplementationOnce(async () => Response.json({ message: "Invalid credentials" }, { status: 401 }));
    await submit();
    expect(passwordLogin).toHaveBeenCalledTimes(1);
    expect(dom.root.textContent).toContain("Invalid credentials");
    expect(opensWithApp()).toBe(true);
    await submit();
    expect(passwordLogin).toHaveBeenCalledTimes(2);
    // Read through the chooser: happy-dom drops a `max-age=0` cookie only on the next millisecond.
    expect(opensWithApp()).toBe(false);
    expect(dom.document.cookie).toContain("login_method=ipa");
    expect(dom.window.location.pathname).toBe("/auth/continue");
  });
});
