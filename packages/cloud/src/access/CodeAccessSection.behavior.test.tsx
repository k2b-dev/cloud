import { describe, expect, test } from "bun:test";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../../ui/test/dom";
import type { AccessEntry } from "../contracts/shared";

const waitFor = async (condition: () => boolean, label: string) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${label}`);
};

/** happy-dom has no Popover API; the picker's result list opens through it. */
const installPopoverApi = (dom: DomTestHarness) => {
  const prototype = dom.window.HTMLElement.prototype as unknown as Record<string, unknown>;
  const open = new WeakSet<object>();
  const matches = prototype.matches as (this: Element, selector: string) => boolean;
  Object.assign(prototype, {
    matches(this: Element, selector: string) {
      return selector === ":popover-open" ? open.has(this) : matches.call(this, selector);
    },
    showPopover(this: object) {
      open.add(this);
    },
    hidePopover(this: object) {
      open.delete(this);
    },
    scrollIntoView() {},
  });
};

const ids = {
  info: "22222222-2222-4222-8222-222222222222",
  base: "33333333-3333-4333-8333-333333333333",
  grantInfo: "44444444-4444-4444-8444-444444444444",
  grantBase: "55555555-5555-4555-8555-555555555555",
};
const person: AccessEntry = {
  id: "access-ben",
  principal: { type: "user", userId: "user-ben" },
  permission: "admin",
  createdAt: "2026-10-28T09:00:00.000Z",
  displayName: "Ben Schulz",
};
const code = (id: string, account: string, grantId: string | undefined, permission: "read" | "write"): AccessEntry => ({
  id,
  principal: { type: "service_account", serviceAccountId: account },
  permission,
  createdAt: "2026-10-28T09:00:00.000Z",
  // What the target's share list resolves: the raw account name, never shown.
  displayName: `code:fixture:${account}`,
  serviceAccountKind: "code",
  ...(grantId ? { grantId } : {}),
});
const entries = [person, code("access-info", ids.info, ids.grantInfo, "write"), code("access-base", ids.base, ids.grantBase, "read")];
const accounts = {
  items: [
    { id: ids.info, ownerTitle: "info@moebel-beispiel.de", appId: "mail", icon: "ti ti-mail", accent: "#0f766e" },
    { id: ids.base, ownerTitle: "Einkauf", appId: "grids", icon: "ti ti-layout-grid", accent: "#008f4c" },
  ],
};

type Call = { url: string; body: unknown };
const setup = async (options: {
  respond: (call: Call) => Response | Promise<Response>;
  initialEntries?: AccessEntry[];
  canEdit?: boolean;
  expanded?: boolean;
  confirm?: boolean;
}) => {
  const dom = createDomTestHarness();
  installPopoverApi(dom);
  dom.document.documentElement.lang = "de";
  // The share dialog belongs to the target application; Core removes the grant there.
  const shell = dom.document.createElement("script");
  shell.id = "cloud-shell-data";
  shell.type = "application/json";
  shell.textContent = JSON.stringify({ appId: "spaces", apps: [] });
  dom.document.body.append(shell);
  const calls: Call[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      const call = { url, body: init?.body ? JSON.parse(String(init.body)) : undefined };
      calls.push(call);
      return options.respond(call);
    },
    { preconnect: originalFetch.preconnect },
  );
  const { prompts, LocaleProvider } = await import("@k2b/ui");
  const originalConfirm = prompts.confirm;
  const confirmations: { content: string; options: unknown }[] = [];
  prompts.confirm = async (content, confirmOptions) => {
    const holder = dom.document.createElement("div");
    const dispose = render(() => content as never, holder);
    confirmations.push({ content: holder.textContent ?? "", options: confirmOptions });
    dispose();
    return options.confirm ?? true;
  };
  const { default: PermissionEditor } = await import("./PermissionEditor");
  delegateEvents(["input", "click"], dom.document);
  const revoked: string[] = [];
  const dispose = render(
    () => (
      <LocaleProvider locale="de">
        <PermissionEditor
          expanded={options.expanded}
          canEdit={options.canEdit}
          initialEntries={options.initialEntries ?? entries}
          grantAccess={async () => {
            throw new Error("Not used");
          }}
          updateAccess={async () => {}}
          revokeAccess={async (id) => {
            revoked.push(id);
          }}
        />
      </LocaleProvider>
    ),
    dom.root,
  );
  const section = () => dom.root.querySelector<HTMLElement>("section");
  const codeRows = () => Array.from(dom.root.querySelectorAll<HTMLElement>("[data-code-access-row]"));
  const shareRows = () => Array.from(dom.root.querySelectorAll<HTMLElement>(".group\\/access-row"));
  return {
    dom,
    calls,
    confirmations,
    revoked,
    section,
    codeRows,
    shareRows,
    cleanup: () => {
      dispose();
      prompts.confirm = originalConfirm;
      globalThis.fetch = originalFetch;
      dom.cleanup();
    },
  };
};
const accountsResponse = () => Response.json(accounts);

describe("Code with access in the shared rights editor", () => {
  if (isServer) {
    test.skip("runs with browser export conditions", () => {});
    return;
  }

  for (const expanded of [false, true]) {
    test(`${expanded ? "expanded" : "compact"}: lists Code apart from people, named live after its owner, with its level`, async () => {
      const view = await setup({ expanded, respond: accountsResponse });
      try {
        await waitFor(() => view.section()?.textContent?.includes("Code von info@moebel-beispiel.de") === true, "owner titles");
        // Code accounts are never ordinary share rows and never show their account name.
        expect(view.shareRows()).toHaveLength(1);
        expect(view.shareRows()[0]!.textContent).toContain("Ben Schulz");
        expect(view.dom.root.textContent).not.toContain("code:fixture");
        expect(view.calls).toEqual([{ url: "/api/resources/code-access/accounts", body: { ids: [ids.base, ids.info].sort() } }]);
        const heading = view.section()!.querySelector("h3")!;
        expect(heading.textContent).toBe("Code mit Zugriff2");
        expect(view.section()!.getAttribute("aria-labelledby")).toBe(heading.id);
        expect(view.codeRows().map((row) => row.textContent)).toEqual([
          "Code von info@moebel-beispiel.deBearbeitenEntfernen",
          "Code von EinkaufAnsehenEntfernen",
        ]);
        expect(view.codeRows()[0]!.querySelector("i.ti-mail")).not.toBeNull();
        expect(view.codeRows()[1]!.querySelector("i.ti-layout-grid")).not.toBeNull();
        expect(view.section()!.textContent).toContain("Code bekommt Zugriff nur beim Einschalten, nie hier.");
      } finally {
        view.cleanup();
      }
    });
  }

  test("removing confirms what pauses and who can restore it, then removes through Core and the target's code.access.rm", async () => {
    let finish: (() => void) | undefined;
    const view = await setup({
      expanded: true,
      respond: ({ url }) =>
        url.endsWith("/accounts")
          ? accountsResponse()
          : new Promise<Response>((resolve) => {
              finish = () => resolve(Response.json({ removed: true }));
            }),
    });
    try {
      await waitFor(() => view.codeRows()[0]?.textContent?.includes("info@") === true, "owner titles");
      const button = view.codeRows()[0]!.querySelector<HTMLButtonElement>("button")!;
      expect(button.getAttribute("aria-label")).toBe("Zugriff von „Code von info@moebel-beispiel.de“ entfernen");
      button.click();
      await waitFor(() => view.calls.length === 2, "the removal request");
      expect(view.confirmations).toEqual([
        {
          content:
            "Was diesen Zugriff braucht, ist dann pausiert. Was der Code schon angelegt hat, bleibt." +
            "Wieder einschalten kann, wer info@moebel-beispiel.de verwaltet und hier „Verwalten“ hat.",
          options: {
            title: "Zugriff von „Code von info@moebel-beispiel.de“ entfernen?",
            confirmText: "Zugriff entfernen",
            variant: "danger",
          },
        },
      ]);
      expect(view.calls[1]).toEqual({ url: "/api/resources/code-access/remove", body: { appId: "spaces", grantId: ids.grantInfo } });
      // Pending: this row says so, the other Code row waits, people rows and their own removal stay untouched.
      expect(view.codeRows()[0]!.getAttribute("aria-busy")).toBe("true");
      expect(view.codeRows()[1]!.querySelector("button")!.disabled).toBe(true);
      finish!();
      await waitFor(() => view.codeRows().length === 1, "the removed row");
      expect(view.codeRows()[0]!.textContent).toContain("Code von Einkauf");
      expect(view.section()!.querySelector("h3")!.textContent).toBe("Code mit Zugriff1");
      // An ordinary revoke never ran for a Code entry.
      expect(view.revoked).toEqual([]);
    } finally {
      view.cleanup();
    }
  });

  test("a cancelled confirmation changes nothing", async () => {
    const view = await setup({ respond: accountsResponse, confirm: false });
    try {
      await waitFor(() => view.codeRows()[0]?.textContent?.includes("info@") === true, "owner titles");
      view.codeRows()[0]!.querySelector<HTMLButtonElement>("button")!.click();
      await waitFor(() => view.confirmations.length === 1, "the confirmation");
      await Bun.sleep(20);
      expect(view.calls).toHaveLength(1);
      expect(view.codeRows()).toHaveLength(2);
    } finally {
      view.cleanup();
    }
  });

  for (const [label, response, message] of [
    ["no longer manages", () => Response.json({ code: "FORBIDDEN", message: "x" }, { status: 403 }), "Du verwaltest das hier nicht mehr"],
    ["not removed", () => Response.json({ removed: false }), "Nicht entfernt. Vielleicht ist der Zugriff schon weg"],
    ["offline", () => Response.json({ code: "UNAVAILABLE", message: "x" }, { status: 503 }), "Der Zugriff konnte nicht entfernt werden."],
  ] as const) {
    test(`removal failure (${label}) stays on the row with a retry`, async () => {
      let attempts = 0;
      const view = await setup({
        expanded: true,
        respond: ({ url }) => {
          if (url.endsWith("/accounts")) return accountsResponse();
          attempts += 1;
          return attempts === 1 ? response() : Response.json({ removed: true });
        },
      });
      try {
        await waitFor(() => view.codeRows()[0]?.textContent?.includes("info@") === true, "owner titles");
        view.codeRows()[0]!.querySelector<HTMLButtonElement>("button")!.click();
        await waitFor(() => view.section()!.querySelector("[role=alert]") !== null, "the failure");
        const alert = view.section()!.querySelector<HTMLElement>("[role=alert]")!;
        expect(alert.textContent).toContain(message);
        expect(view.codeRows()).toHaveLength(2);
        alert.querySelector<HTMLButtonElement>("button")!.click();
        await waitFor(() => view.codeRows().length === 1, "the retried removal");
        expect(view.section()!.querySelector("[role=alert]")).toBeNull();
      } finally {
        view.cleanup();
      }
    });
  }

  test("loading holds a row per entry, a failure keeps people correct and retries", async () => {
    let attempt = 0;
    let release: (() => void) | undefined;
    const view = await setup({
      respond: () => {
        attempt += 1;
        if (attempt === 1) return new Response("down", { status: 503 });
        return new Promise<Response>((resolve) => {
          release = () => resolve(accountsResponse());
        });
      },
    });
    try {
      await waitFor(() => view.section()?.querySelector("[role=alert]") !== null, "the load failure");
      expect(view.section()!.textContent).toContain("Code mit Zugriff konnte nicht geladen werden. Die Personen oben stimmen.");
      expect(view.shareRows()).toHaveLength(1);
      view.section()!.querySelector<HTMLButtonElement>("[role=alert] button")!.click();
      await waitFor(() => release !== undefined, "the retry");
      expect(view.section()!.getAttribute("aria-busy")).toBe("true");
      expect(view.codeRows()).toHaveLength(2);
      expect(view.section()!.querySelectorAll(".k2b-skeleton").length).toBeGreaterThan(0);
      expect(view.codeRows()[0]!.querySelector("button")!.disabled).toBe(true);
      release!();
      await waitFor(() => view.section()?.getAttribute("aria-busy") === null, "the loaded section");
      expect(view.codeRows()[0]!.textContent).toContain("Code von info@moebel-beispiel.de");
    } finally {
      view.cleanup();
    }
  });

  test("an owner the person cannot read keeps the row without naming it", async () => {
    const view = await setup({
      respond: () => Response.json({ items: [{ id: ids.info, ownerTitle: null, appId: null, icon: null, accent: null }] }),
      initialEntries: [person, entries[1]!],
    });
    try {
      await waitFor(() => view.section()?.getAttribute("aria-busy") === null, "the loaded section");
      expect(view.codeRows()[0]!.textContent).toBe("Code, dessen Besitzer du nicht sehen kannstBearbeitenEntfernen");
      expect(view.codeRows()[0]!.querySelector("i.ti-code")).not.toBeNull();
    } finally {
      view.cleanup();
    }
  });

  test("without Code entries the section is absent and nothing is requested", async () => {
    const view = await setup({ respond: accountsResponse, initialEntries: [person] });
    try {
      await Bun.sleep(20);
      expect(view.section()).toBeNull();
      expect(view.calls).toEqual([]);
    } finally {
      view.cleanup();
    }
  });

  test("people who cannot change access see Code read-only, and a Code entry without a grant offers no removal", async () => {
    const readOnly = await setup({ respond: accountsResponse, canEdit: false });
    try {
      await waitFor(() => readOnly.codeRows()[0]?.textContent?.includes("info@") === true, "owner titles");
      expect(readOnly.section()!.querySelectorAll("button")).toHaveLength(0);
    } finally {
      readOnly.cleanup();
    }
    const withoutGrant = await setup({
      respond: accountsResponse,
      initialEntries: [person, code("access-info", ids.info, undefined, "write")],
    });
    try {
      await waitFor(() => withoutGrant.codeRows()[0]?.textContent?.includes("info@") === true, "owner titles");
      expect(withoutGrant.codeRows()[0]!.querySelector("button")).toBeNull();
    } finally {
      withoutGrant.cleanup();
    }
  });

  test("Code accounts never appear in the principal picker, even when the directory returns one", async () => {
    const view = await setup({
      respond: ({ url }) =>
        url.includes("/api/accounts/entities")
          ? Response.json({
              items: [
                {
                  kind: "service_account",
                  serviceAccount: { id: "found-code", name: "code:mail.mailbox:mb_info", kind: "code", status: "active" },
                },
                { kind: "user", user: { id: "found-mia", displayName: "Mia Koch", uid: "mia", mail: "mia@example.com" } },
              ],
            })
          : accountsResponse(),
      initialEntries: [person],
    });
    try {
      const input = view.dom.root.querySelector<HTMLInputElement>("input[role=combobox]")!;
      input.value = "in";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await waitFor(() => view.dom.root.querySelectorAll("[role=option]").length > 0, "the results");
      const options = Array.from(view.dom.root.querySelectorAll("[role=option]")).map((option) => option.textContent ?? "");
      expect(options.some((text) => text.includes("Mia Koch"))).toBe(true);
      expect(options.some((text) => text.includes("code:"))).toBe(false);
    } finally {
      view.cleanup();
    }
  });
});

describe("Sharing a Code itself", () => {
  if (isServer) {
    test.skip("runs with browser export conditions", () => {});
    return;
  }

  test("offers Reader and Editor for people and groups only", async () => {
    const dom = createDomTestHarness();
    installPopoverApi(dom);
    const requested: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request) => {
        requested.push(new URL(input instanceof Request ? input.url : input.toString()).searchParams.get("kinds") ?? "");
        return Response.json({ items: [] });
      },
      { preconnect: originalFetch.preconnect },
    );
    const { LocaleProvider } = await import("@k2b/ui");
    const { default: PermissionEditor } = await import("./PermissionEditor");
    const { codeSharing } = await import("./code-sharing");
    delegateEvents(["input", "click"], dom.document);
    const dispose = render(
      () => (
        <LocaleProvider locale="de">
          <PermissionEditor
            {...codeSharing("de")}
            initialEntries={[{ ...person, permission: "write" }]}
            grantAccess={async () => {
              throw new Error("Not used");
            }}
            updateAccess={async () => {}}
            revokeAccess={async () => {}}
          />
        </LocaleProvider>
      ),
      dom.root,
    );
    try {
      const row = dom.root.querySelector<HTMLElement>(".group\\/access-row")!;
      expect(Array.from(row.querySelectorAll("[role=menuitemradio]")).map((item) => item.textContent?.split("Sieht")[0])).toEqual([
        "Leser",
        "Bearbeiter",
      ]);
      const input = dom.root.querySelector<HTMLInputElement>("input[role=combobox]")!;
      expect(input.placeholder).toBe("Benutzer oder Gruppe hinzufügen…");
      input.value = "be";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await waitFor(() => requested.length > 0, "the directory search");
      expect(requested).toEqual(["user,group"]);
      // Neither all signed-in people nor the public is offered.
      expect(dom.root.querySelectorAll("[role=option]")).toHaveLength(0);
    } finally {
      dispose();
      globalThis.fetch = originalFetch;
      dom.cleanup();
    }
  });
});
