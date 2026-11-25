import { afterEach, describe, expect, mock, test } from "bun:test";
import { DEFAULT_ACCOUNT_CATEGORY_POLICY } from "@k2b/cloud/contracts";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";

const requests: Array<{ kind: string; payload: Record<string, unknown>; signal: AbortSignal; resolve: (response: Response) => void }> = [];
if (!isServer) {
  const post =
    (kind: string) =>
    ({ json }: { json: Record<string, unknown> }, options: { init: { signal: AbortSignal } }) =>
      new Promise<Response>((resolve) => requests.push({ kind, payload: structuredClone(json), signal: options.init.signal, resolve }));
  mock.module("@/api/client", () => ({ apiClient: { users: { $post: post("user") }, groups: { $post: post("group") } } }));
}
const flush = async () => {
  for (let index = 0; index < 12; index++) await Promise.resolve();
};
const input = (document: Document, selector: string, value: string) => {
  const field = document.querySelector<HTMLInputElement>(selector);
  if (!field) throw new Error(`Missing field: ${selector}`);
  field.value = value;
  field.dispatchEvent(new Event("input", { bubbles: true }));
};
const button = (document: Document, label: string) => {
  const found = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (entry) =>
      entry.getAttribute("aria-label") === label ||
      entry.textContent?.trim() === label ||
      entry.querySelector("span")?.textContent?.trim() === label,
  );
  if (!found) throw new Error(`Missing button ${label}`);
  return found;
};
const submit = (document: Document) =>
  document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

// Happy DOM exercises component behavior only; this is not a browser clickthrough.
describe("Accounts creation forms", () => {
  if (isServer) {
    test.skip("requires the package DOM runner", () => {});
    return;
  }
  let cleanup = () => {};
  afterEach(() => {
    cleanup();
    requests.length = 0;
  });

  test("user fields survive API failure, retry submits once and successful creation closes", async () => {
    const dom = createDomTestHarness();
    const { CreateUserDialog } = await import("../src/frontend/users/new/CreateUserForm.island");
    const results: unknown[] = [];
    const dispose = render(
      () =>
        createComponent(CreateUserDialog, {
          categoryPolicy: DEFAULT_ACCOUNT_CATEGORY_POLICY,
          freeIpaEnabled: false,
          close: (value) => results.push(value),
        }),
      dom.root,
    );
    cleanup = () => {
      dispose();
      dom.cleanup();
    };
    input(dom.document, 'input[autocomplete="given-name"]', "Ada");
    input(dom.document, 'input[autocomplete="family-name"]', "Lovelace");
    input(dom.document, 'input[type="email"]', "ada@example.com");
    expect(dom.document.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
    button(dom.document, "Choose an account type").click();
    await flush();
    button(dom.document, "Login").click();
    await flush();
    expect(dom.document.querySelector<HTMLInputElement>('input[type="email"]')!.required).toBe(true);
    const form = dom.document.querySelector("form")!;
    expect(dom.document.querySelector('button[type="submit"]')!.getAttribute("form")).toBe(form.id);
    submit(dom.document);
    submit(dom.document);
    await flush();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.payload).toMatchObject({
      provider: "local",
      profile: "user",
      admin: false,
      email: "ada@example.com",
      displayName: "Ada Lovelace",
      autoSendNotification: true,
    });
    expect(button(dom.document, "Cancel").disabled).toBe(true);
    requests[0]!.resolve(Response.json({ message: "Address already exists" }, { status: 409 }));
    await flush();
    expect(dom.document.querySelector('[role="alert"]')!.textContent).toContain("Address already exists");
    expect(dom.document.querySelector<HTMLInputElement>('input[type="email"]')!.value).toBe("ada@example.com");
    expect(results).toHaveLength(0);
    input(dom.document, 'input[type="email"]', "ada.new@example.com");
    submit(dom.document);
    await flush();
    requests[1]!.resolve(Response.json({ id: "user-1", uid: "ada", accountExpires: null, notificationSent: true }));
    await flush();
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ payload: { email: "ada.new@example.com" }, data: { id: "user-1" } });
  });

  test("Login accounts may skip the email only while the installation allows it; guests never", async () => {
    const dom = createDomTestHarness();
    const { CreateUserDialog } = await import("../src/frontend/users/new/CreateUserForm.island");
    const dispose = render(
      () =>
        createComponent(CreateUserDialog, {
          categoryPolicy: DEFAULT_ACCOUNT_CATEGORY_POLICY,
          freeIpaEnabled: false,
          localEmailOptional: true,
          close: () => {},
        }),
      dom.root,
    );
    cleanup = () => {
      dispose();
      dom.cleanup();
    };
    input(dom.document, 'input[autocomplete="given-name"]', "Ada");
    input(dom.document, 'input[autocomplete="family-name"]', "Lovelace");
    button(dom.document, "Choose an account type").click();
    await flush();
    button(dom.document, "Guest").click();
    await flush();
    expect(dom.document.querySelector<HTMLInputElement>('input[type="email"]')!.required).toBe(true);
    submit(dom.document);
    await flush();
    expect(requests).toHaveLength(0);

    button(dom.document, "Guest").click();
    await flush();
    button(dom.document, "Login").click();
    await flush();
    expect(dom.document.querySelector<HTMLInputElement>('input[type="email"]')!.required).toBe(false);
    expect(dom.document.body.textContent).toContain("signs in with a paired app or a passkey");
    const welcome = [...dom.document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].at(-1)!;
    expect(welcome.checked).toBe(false);
    expect(welcome.disabled).toBe(true);
    submit(dom.document);
    await flush();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.payload).toMatchObject({ provider: "local", profile: "user", autoSendNotification: false });
    expect(requests[0]!.payload.email).toBeUndefined();

    // Typing an address restores the normal welcome flow.
    requests[0]!.resolve(Response.json({ message: "Local accounts need an email address." }, { status: 400 }));
    await flush();
    input(dom.document, 'input[type="email"]', "ada@example.com");
    await flush();
    expect(welcome.checked).toBe(true);
    expect(welcome.disabled).toBe(false);
  });

  test("provider and profile switches preserve person data and clear incompatible administrator access", async () => {
    const dom = createDomTestHarness();
    const { CreateUserDialog } = await import("../src/frontend/users/new/CreateUserForm.island");
    const dispose = render(
      () => createComponent(CreateUserDialog, { categoryPolicy: DEFAULT_ACCOUNT_CATEGORY_POLICY, freeIpaEnabled: true, close: () => {} }),
      dom.root,
    );
    cleanup = () => {
      dispose();
      dom.cleanup();
    };
    input(dom.document, 'input[autocomplete="given-name"]', "Ada");
    input(dom.document, 'input[autocomplete="family-name"]', "Lovelace");
    input(dom.document, 'input[type="email"]', "ada@example.com");
    button(dom.document, "Choose an account type").click();
    await flush();
    expect(dom.document.querySelector('[role="option"][aria-label="Login"]')!.textContent).toContain("Local account managed in Cloud");
    expect(dom.document.querySelector('[role="option"][aria-label="Guest"]')!.textContent).toContain("restricted guest profile");
    button(dom.document, "Login").click();
    await flush();
    expect(dom.document.body.textContent).toContain("No password is created");
    const admin = dom.document.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    admin.click();
    expect(admin.checked).toBe(true);
    button(dom.document, "Login").click();
    await flush();
    button(dom.document, "Guest").click();
    await flush();
    submit(dom.document);
    await flush();
    expect(requests[0]!.payload).toMatchObject({ provider: "local", profile: "guest", admin: false, givenname: "Ada" });
    expect(dom.document.querySelector<HTMLInputElement>('input[autocomplete="given-name"]')!.value).toBe("Ada");
    dispose();
    expect(requests[0]!.signal.aborted).toBe(true);
  });

  // The dialog for a new group is v2 now; its cases (empty normalized names, local POSIX, switching who manages it,
  // discarding an edited form) run in a real browser: src/frontend/groups/detail/group-screen.browser.test.ts.

  for (const creationNotice of [undefined, { markdown: "Review workstation setup.", failed: false }, { markdown: null, failed: true }]) {
    test(`successful creation keeps its result with notice ${creationNotice ? (creationNotice.failed ? "failure" : "content") : "disabled"}`, async () => {
      const dom = createDomTestHarness();
      dom.window.location.href = "http://localhost/app/accounts/users/new";
      const { default: CreateUserForm } = await import("../src/frontend/users/new/CreateUserForm.island");
      const { dialogCore } = await import("@k2b/ui");
      const dispose = render(
        () => createComponent(CreateUserForm, { categoryPolicy: DEFAULT_ACCOUNT_CATEGORY_POLICY, freeIpaEnabled: false, autoOpen: true }),
        dom.root,
      );
      cleanup = () => {
        dialogCore.close();
        dispose();
        dom.cleanup();
      };
      await flush();
      input(dom.document, 'input[autocomplete="given-name"]', "Ada");
      input(dom.document, 'input[autocomplete="family-name"]', "Lovelace");
      input(dom.document, 'input[type="email"]', "ada@example.com");
      expect(dom.document.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
      button(dom.document, "Choose an account type").click();
      await flush();
      button(dom.document, "Login").click();
      await flush();
      submit(dom.document);
      await flush();
      requests[0]!.resolve(Response.json({ id: "user-1", uid: "ada", accountExpires: null, notificationSent: true, creationNotice }));
      await flush();
      expect(dom.document.body.textContent).not.toContain("nfsctl");
      if (creationNotice?.markdown) expect(dom.document.body.textContent).toContain("Review workstation setup.");
      else expect(dom.document.body.textContent).not.toContain("Review workstation setup.");
      if (creationNotice?.failed) expect(dom.document.body.textContent).toContain("The change succeeded.");
      button(dom.document, "Close").click();
      await flush();
      expect(dom.window.location.pathname).toBe("/app/accounts/users");
      expect(dom.document.querySelector("form")).toBeNull();
    });
  }

  test("request prefill keeps FreeIPA ownership and its request ID", async () => {
    const dom = createDomTestHarness();
    const { CreateUserDialog } = await import("../src/frontend/users/new/CreateUserForm.island");
    const dispose = render(
      () =>
        createComponent(CreateUserDialog, {
          categoryPolicy: DEFAULT_ACCOUNT_CATEGORY_POLICY,
          freeIpaEnabled: true,
          prefill: { requestId: "request-1", email: "ada@example.com", givenname: "Ada", sn: "Lovelace", firstName: "Ada" },
          close: () => {},
        }),
      dom.root,
    );
    cleanup = () => {
      dispose();
      dom.cleanup();
    };
    button(dom.document, "Choose an account type").click();
    await flush();
    const option = dom.document.querySelector('[role="option"][aria-label="FreeIPA"]')!;
    expect(option.textContent).toContain("Managed in FreeIPA");
    button(dom.document, "FreeIPA").click();
    await flush();
    const info = dom.document.querySelector('[data-tone="info"]:last-of-type');
    expect(dom.document.body.textContent).toContain("FreeIPA generates a temporary password");
    expect(dom.document.body.textContent).toContain("welcome email includes the username, temporary password");
    const welcome = dom.document.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    welcome.click();
    await flush();
    expect(dom.document.body.textContent).toContain("The generated password is not shown here");
    expect(dom.document.body.textContent).not.toContain("welcome email includes the username, temporary password");
    expect(info).not.toBeNull();
    submit(dom.document);
    await flush();
    expect(requests[0]!.payload).toMatchObject({ provider: "ipa", requestId: "request-1", autoSendNotification: false });
    expect(requests[0]!.payload).not.toHaveProperty("profile");
  });
});
