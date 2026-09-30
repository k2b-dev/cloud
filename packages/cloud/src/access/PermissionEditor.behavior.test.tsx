import { describe, expect, test } from "bun:test";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../../ui/test/dom";
import type { AccessEntry, Principal, ServiceAccountKind } from "../contracts/shared";

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

const labels = {
  en: {
    agent: "Agent",
    standalone: "Service account",
    resource_bound: "Resource-bound service account",
    user_delegated: "User-bound service account",
  },
  de: {
    agent: "Agent",
    standalone: "Dienstkonto",
    resource_bound: "Ressourcengebundenes Dienstkonto",
    user_delegated: "Benutzergebundenes Dienstkonto",
  },
} as const;
const icons: Record<ServiceAccountKind, string> = {
  agent: "ti-robot",
  standalone: "ti-key",
  resource_bound: "ti-box",
  user_delegated: "ti-user-key",
};
const kinds = Object.keys(icons) as ServiceAccountKind[];

const serviceEntry = (kind?: ServiceAccountKind): AccessEntry => ({
  id: `access-${kind ?? "unknown"}`,
  principal: { type: "service_account", serviceAccountId: `granted-${kind ?? "unknown"}` },
  permission: "read",
  createdAt: "2026-09-30T00:00:00.000Z",
  displayName: `Granted ${kind ?? "unknown"}`,
  ...(kind ? { serviceAccountKind: kind } : {}),
});
const binding = (kind: ServiceAccountKind) =>
  kind === "resource_bound"
    ? { appId: "contacts", resourceType: "book", resourceId: "book-1" }
    : { appId: null, resourceType: null, resourceId: null };

describe("PermissionEditor service accounts", () => {
  if (isServer) {
    test.skip("runs with browser export conditions", () => {});
    return;
  }

  for (const locale of ["en", "de"] as const) {
    test(`${locale}: rows, picker results, and a new grant show the same kind`, async () => {
      const dom = createDomTestHarness();
      installPopoverApi(dom);
      dom.document.documentElement.lang = locale;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = Object.assign(
        async () =>
          Response.json({
            items: kinds.map((kind) => ({
              kind: "service_account",
              serviceAccount: { id: `found-${kind}`, name: `Found ${kind}`, kind, ...binding(kind) },
            })),
          }),
        { preconnect: originalFetch.preconnect },
      );
      const { default: PermissionEditor } = await import("./PermissionEditor");
      delegateEvents(["input", "click"]);
      const rowOf = (name: string) =>
        Array.from(dom.root.querySelectorAll<HTMLElement>(".group\\/access-row")).find((row) => row.textContent?.includes(name));
      const granted: { principal: Principal; kind?: ServiceAccountKind }[] = [];
      const dispose = render(
        () => (
          <PermissionEditor
            initialEntries={[...kinds.map(serviceEntry), serviceEntry()]}
            allowAuthenticated={false}
            allowServiceAccounts
            // A deferred draft builds its entry from the display metadata the picker hands over.
            grantAccess={async (principal, permission, display) => {
              granted.push({ principal, kind: display?.serviceAccountKind });
              return { id: "access-new", principal, permission, createdAt: "2026-09-30T00:00:00.000Z", ...display };
            }}
            updateAccess={async () => {}}
            revokeAccess={async () => {}}
          />
        ),
        dom.root,
      );
      try {
        for (const kind of kinds) {
          const row = rowOf(`Granted ${kind}`)!;
          expect(row.querySelector(`i.${icons[kind]}`)).not.toBeNull();
          expect(row.textContent).toContain(`(${labels[locale][kind]})`);
        }
        // An entry whose consumer did not resolve the kind makes no claim about it.
        const unknown = rowOf("Granted unknown")!;
        expect(unknown.querySelector("i.ti-key")).not.toBeNull();
        expect(unknown.textContent).not.toContain("(");

        const input = dom.root.querySelector<HTMLInputElement>("input[role=combobox]")!;
        input.value = "fo";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        await waitFor(() => dom.root.querySelectorAll("[role=option]").length === kinds.length, "the service-account results");
        const options = Array.from(dom.root.querySelectorAll<HTMLButtonElement>("[role=option]"));
        for (const kind of kinds) {
          const option = options.find((element) => element.textContent?.includes(`Found ${kind}`))!;
          expect(option.querySelector(`i.${icons[kind]}`)).not.toBeNull();
          // Resource-bound accounts often share a name, so their result shows the binding instead.
          expect(option.querySelector("small")?.textContent).toBe(
            kind === "resource_bound" ? "contacts · book · book-1" : labels[locale][kind],
          );
        }

        options.find((element) => element.textContent?.includes("Found agent"))!.click();
        await waitFor(() => rowOf("Found agent") !== undefined, "the new agent row");
        expect(granted).toEqual([{ principal: { type: "service_account", serviceAccountId: "found-agent" }, kind: "agent" }]);
        const added = rowOf("Found agent")!;
        expect(added.querySelector("i.ti-robot")).not.toBeNull();
        expect(added.textContent).toContain(`(${labels[locale].agent})`);
      } finally {
        dispose();
        globalThis.fetch = originalFetch;
        dom.cleanup();
      }
    });
  }
});
