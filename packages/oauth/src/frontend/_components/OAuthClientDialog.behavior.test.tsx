import { describe, expect, spyOn, test } from "bun:test";
import { createSignal } from "solid-js";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";
import type { OAuthClient, UpdateOAuthClient } from "../../contracts";

const client = (overrides: Partial<OAuthClient> = {}): OAuthClient => ({
  id: "11111111-1111-4111-8111-111111111111",
  name: "Existing client",
  description: "Original",
  clientId: "existing-client",
  redirectUris: ["https://one.example/callback", "https://two.example/callback"],
  logoutUri: null,
  scopes: ["openid", "email"],
  audiences: ["custom-api"],
  serviceAccountId: null,
  allowedProfiles: ["guest"],
  accessMode: "specific",
  accessUsers: [{ id: "22222222-2222-4222-8222-222222222222", uid: "guest", displayName: "Guest", mail: null, provider: "local" }],
  accessGroups: [],
  registrationKind: "managed",
  isPublic: false,
  allowDeviceGrant: false,
  createdAt: "2026-09-15T00:00:00Z",
  createdBy: null,
  ...overrides,
});

const button = (root: HTMLElement, label: string) => {
  const found = Array.from(root.querySelectorAll("button")).find((node) => node.textContent?.trim() === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
};

describe("OAuth client editor DOM", () => {
  if (isServer) {
    test.skip("requires --conditions=browser and packages/ui/test/solid-dom-preload.ts", () => {});
    return;
  }

  test("editing description submits every callback and preserves guest-only specific access", async () => {
    const dom = createDomTestHarness();
    delegateEvents(["click", "input"], dom.document);
    const network = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network request"));
    const { default: OAuthClientDialog } = await import("./OAuthClientDialog");
    const existing = client();
    const submissions: UpdateOAuthClient[] = [];
    const dispose = render(
      () => (
        <OAuthClientDialog
          mode="edit"
          client={existing}
          close={() => {}}
          loading={() => false}
          onSubmit={async (value) => {
            submissions.push(value);
          }}
        />
      ),
      dom.root,
    );
    try {
      const textarea = dom.root.querySelector("textarea");
      expect(textarea?.value).toBe(existing.redirectUris.join("\n"));
      expect(dom.root.textContent).toContain("Guests only");
      const description = dom.root.querySelector<HTMLInputElement>('input[placeholder="Optional description for this client"]');
      if (!description) throw new Error("Description field missing");
      description.value = "Edited description";
      description.dispatchEvent(new Event("input", { bubbles: true }));
      button(dom.root, "Save").click();
      await Promise.resolve();
      expect(submissions).toHaveLength(1);
      expect(submissions[0]?.description).toBe("Edited description");
      expect(submissions[0]?.redirectUris).toEqual(existing.redirectUris);
      expect(submissions[0]?.allowedProfiles).toEqual(["guest"]);
      expect(submissions[0]?.accessMode).toBe("specific");
      expect(submissions[0]?.allowedUserIds).toEqual(existing.accessUsers.map((user) => user.id));
      expect(submissions[0]).not.toHaveProperty("audiences");
      expect(network).not.toHaveBeenCalled();
    } finally {
      dispose();
      network.mockRestore();
      dom.cleanup();
    }
  });

  test("machine client saves without callbacks and disables repeated saves and header dismissal while saving", async () => {
    const dom = createDomTestHarness();
    delegateEvents(["click", "input"], dom.document);
    const { default: OAuthClientDialog } = await import("./OAuthClientDialog");
    const [loading, setLoading] = createSignal(false);
    const submissions: UpdateOAuthClient[] = [];
    let closed = 0;
    const dispose = render(
      () => (
        <OAuthClientDialog
          mode="edit"
          client={client({ redirectUris: [], allowedProfiles: [], accessMode: "profiles", accessUsers: [] })}
          close={() => {
            closed++;
          }}
          loading={loading}
          onSubmit={async (value) => {
            submissions.push(value);
            setLoading(true);
          }}
        />
      ),
      dom.root,
    );
    try {
      expect(dom.root.textContent).toContain("No user sign-in");
      const save = button(dom.root, "Save");
      expect(save.disabled).toBe(false);
      save.click();
      await Promise.resolve();
      expect(submissions).toHaveLength(1);
      expect(submissions[0]?.redirectUris).toEqual([]);
      expect(submissions[0]?.allowedProfiles).toEqual([]);
      expect(save.disabled).toBe(true);
      save.click();
      const close = dom.root.querySelector<HTMLButtonElement>('button[aria-label="close dialog"]');
      expect(close?.disabled).toBe(true);
      close?.click();
      expect(closed).toBe(0);
      expect(submissions).toHaveLength(1);
    } finally {
      dispose();
      dom.cleanup();
    }
  });

  test("device sign-in is offered only for public clients and saves its choice", async () => {
    const dom = createDomTestHarness();
    delegateEvents(["click", "input", "change"], dom.document);
    const { default: OAuthClientDialog } = await import("./OAuthClientDialog");
    const submissions: UpdateOAuthClient[] = [];
    const confidential = render(
      () => <OAuthClientDialog mode="edit" client={client()} close={() => {}} loading={() => false} onSubmit={async () => {}} />,
      dom.root,
    );
    expect(dom.root.textContent).not.toContain("Device sign-in");
    confidential();

    const dispose = render(
      () => (
        <OAuthClientDialog
          mode="edit"
          client={client({ isPublic: true, accessMode: "profiles", accessUsers: [] })}
          close={() => {}}
          loading={() => false}
          onSubmit={async (value) => {
            submissions.push(value);
          }}
        />
      ),
      dom.root,
    );
    try {
      const card = Array.from(dom.root.querySelectorAll("label")).find((node) => node.textContent?.includes("Device sign-in"));
      const checkbox = card?.querySelector<HTMLInputElement>('input[type="checkbox"]');
      if (!checkbox) throw new Error("Device sign-in checkbox missing");
      expect(checkbox.checked).toBe(false);
      checkbox.click();
      button(dom.root, "Save").click();
      await Promise.resolve();
      expect(submissions[0]?.allowDeviceGrant).toBe(true);
    } finally {
      dispose();
      dom.cleanup();
    }
  });

  test("create keeps its dialog open on Escape and backdrop while the request is pending", async () => {
    const dom = createDomTestHarness();
    delegateEvents(["click", "input"], dom.document);
    const pending = Promise.withResolvers<Response>();
    const network = spyOn(globalThis, "fetch").mockReturnValue(pending.promise);
    const { default: CreateClientButton } = await import("./CreateClientButton.island");
    const { dialogCore } = await import("@k2b/ui");
    const dispose = render(() => <CreateClientButton />, dom.root);
    try {
      button(dom.root, "New client").click();
      const dialog = dom.document.querySelector("dialog");
      if (!dialog) throw new Error("Create dialog missing");
      const name = dialog.querySelector<HTMLInputElement>('input[placeholder="My Application"]');
      if (!name) throw new Error("Name field missing");
      name.value = "Pending client";
      name.dispatchEvent(new Event("input", { bubbles: true }));
      button(dialog, "Create").click();
      await Promise.resolve();
      expect(network).toHaveBeenCalledTimes(1);
      dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
      await Bun.sleep(10);
      expect(dialogCore.isOpen()).toBe(true);
      expect(dialog.querySelector<HTMLInputElement>('input[placeholder="My Application"]')?.value).toBe("Pending client");
      dialog.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      dialog.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Bun.sleep(10);
      expect(dialogCore.isOpen()).toBe(true);
      pending.resolve(Response.json({ error: "Fixture failure" }, { status: 400 }));
      await Bun.sleep(10);
    } finally {
      dialogCore.close();
      dispose();
      network.mockRestore();
      dom.cleanup();
    }
  });
});
