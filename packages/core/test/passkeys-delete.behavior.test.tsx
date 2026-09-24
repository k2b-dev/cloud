import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { WebAuthnPasskey } from "@k2b/cloud/contracts";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";

const passkey = (id: string, name: string): WebAuthnPasskey => ({
  id,
  userId: "user-1",
  name,
  transports: [],
  deviceType: null,
  backedUp: false,
  createdAt: "2026-09-01T10:00:00.000Z",
  lastUsedAt: null,
});
const laptop = passkey("11111111-1111-4111-8111-111111111111", "Laptop");
const phone = passkey("22222222-2222-4222-8222-222222222222", "Phone");

let deleteResult: () => Promise<Response> = async () => Response.json({ message: "Passkey deleted." });
let listResult: () => Promise<Response> = async () => Response.json({ items: [phone] });
const remove = mock((_input: { param: { id: string } }) => deleteResult());
const list = mock(() => listResult());
if (!isServer) {
  mock.module("@k2b/cloud/clients/core", () => ({
    apiClient: { me: { passkeys: { $get: list, ":id": { $delete: remove } } } },
  }));
}
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe("passkey deletion feedback", () => {
  if (isServer) {
    test.skip("requires browser conditions and the DOM preload", () => {});
    return;
  }
  let cleanup = () => {};
  afterEach(() => {
    cleanup();
    mock.restore();
    remove.mockClear();
    list.mockClear();
    deleteResult = async () => Response.json({ message: "Passkey deleted." });
    listResult = async () => Response.json({ items: [phone] });
  });

  const mount = async () => {
    const dom = createDomTestHarness();
    const { prompts } = await import("@k2b/ui");
    spyOn(prompts, "confirm").mockResolvedValue(true);
    const error = spyOn(prompts, "error").mockResolvedValue(undefined);
    const { default: PasskeysSettings } = await import("../src/pages/me/PasskeysSettings.island");
    const dispose = render(() => createComponent(PasskeysSettings, { initialPasskeys: [laptop, phone] }), dom.root);
    cleanup = () => {
      dispose();
      dom.cleanup();
    };
    const names = () => [...dom.root.querySelectorAll("span.truncate")].map((node) => node.textContent);
    const deleteLaptop = async () => {
      const button = [...dom.root.querySelectorAll("button")].filter((node) => node.textContent?.includes("Delete"))[0]!;
      button.click();
      await flush();
    };
    return { error, names, deleteLaptop };
  };

  test("a confirmed deletion reloads the list from the server", async () => {
    const view = await mount();
    await view.deleteLaptop();
    expect(remove).toHaveBeenCalledWith({ param: { id: laptop.id } });
    expect(list).toHaveBeenCalledTimes(1);
    expect(view.names()).toEqual(["Phone"]);
    expect(view.error).not.toHaveBeenCalled();
  });

  test("a confirmed deletion still leaves the list when the reload fails", async () => {
    listResult = async () => new Response(null, { status: 503 });
    const view = await mount();
    await view.deleteLaptop();
    expect(view.names()).toEqual(["Phone"]);
    expect(view.error).not.toHaveBeenCalled();
  });

  const failures = [
    {
      name: "an expired session asks to sign in again and keeps the passkey",
      response: () => Response.json({ message: "Authentication required" }, { status: 401 }),
      message: "Your session has expired, so the passkey is still active. Sign in again and retry. Error code: HTTP 401",
      names: ["Laptop", "Phone"],
      reloads: 0,
    },
    {
      name: "a credential that may not manage passkeys says so and keeps the passkey",
      response: () => Response.json({ message: "Credentials cannot manage account authentication.", code: "FORBIDDEN" }, { status: 403 }),
      message:
        "This sign-in cannot manage passkeys, so the passkey is still active. Sign in to Cloud directly and retry. Error code: FORBIDDEN",
      names: ["Laptop", "Phone"],
      reloads: 0,
    },
    {
      name: "a passkey that is already gone refreshes the list",
      response: () => Response.json({ message: "Passkey not found", code: "NOT_FOUND" }, { status: 404 }),
      message: "This passkey no longer exists; it was probably removed already. The list has been refreshed. Error code: NOT_FOUND",
      names: ["Phone"],
      reloads: 1,
    },
    {
      name: "a server error says the passkey is still active and hides server prose",
      response: () => Response.json({ message: "relation auth.webauthn_credentials is locked", code: "INTERNAL" }, { status: 500 }),
      message: "Cloud could not delete the passkey, so it is still active. Try again in a moment. Error code: INTERNAL",
      names: ["Laptop", "Phone"],
      reloads: 0,
    },
    {
      name: "an unparseable error body falls back to the HTTP status as its code",
      response: () => new Response("<html>Bad gateway</html>", { status: 502 }),
      message: "Cloud could not delete the passkey, so it is still active. Try again in a moment. Error code: HTTP 502",
      names: ["Laptop", "Phone"],
      reloads: 0,
    },
  ];
  for (const failure of failures) {
    test(failure.name, async () => {
      deleteResult = async () => failure.response();
      const view = await mount();
      await view.deleteLaptop();
      expect(view.error).toHaveBeenCalledWith(failure.message);
      expect(list).toHaveBeenCalledTimes(failure.reloads);
      expect(view.names()).toEqual(failure.names);
    });
  }

  test("a lost connection cannot confirm the deletion and shows the server's current list", async () => {
    deleteResult = async () => {
      throw new TypeError("Failed to fetch");
    };
    listResult = async () => Response.json({ items: [laptop, phone] });
    const view = await mount();
    await view.deleteLaptop();
    expect(view.error).toHaveBeenCalledWith(
      "The connection failed before Cloud confirmed the deletion. Check your connection and reload the page to see whether the passkey is still active.",
    );
    expect(view.names()).toEqual(["Laptop", "Phone"]);
  });
});
