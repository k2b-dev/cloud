import { expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "@typescript/typescript6";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";
import type { CloudResourceRef } from "../contracts/capabilities";
import type { AccessEntry } from "../contracts/shared";

const manager: AccessEntry = {
  id: "grant-manager",
  principal: { type: "user", userId: "manager" },
  displayName: "Mia",
  permission: "admin",
  createdAt: "2026-11-04T00:00:00Z",
};
const handle = "code-7k2q9m4xwt";
const accountId = "20000000-0000-4000-8000-000000000001";
// happy-dom has no Popover API; directory search opens its result list through it.
const installPopoverApi = (window: Window) => {
  const prototype = (window as unknown as { HTMLElement: typeof HTMLElement }).HTMLElement.prototype as unknown as Record<string, unknown>;
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
const waitFor = async (condition: () => boolean) => {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (condition()) return;
    await Bun.sleep(10);
  }
  throw new Error("The targeted service-account flow did not finish");
};

// Read the target expression from each real dialog entry. A missing target or an app-local lookup cannot silently
// turn this into a test of a hand-written copy of the app's configuration. The interaction uses the real shared UI.
const entries = [
  ["Third-party app without Code declarations", "", "inventory.item", {}],
  ["Spaces", "spaces/src/frontend/[id]/_components/edit/AccessSection.tsx", "spaces.space", { spaceId: "Targ01" }],
  ["Spaces admin", "spaces/src/frontend/_components/AdminSpaceActions.island.tsx", "spaces.space", { spaceId: "Targ01" }],
  ["Mail", "mail/src/frontend/_components/MailboxSettings.tsx", "mail.mailbox", { context: { mailbox: { id: "Targ01" } } }],
  ["Mail admin", "mail/src/frontend/_components/MailAdminMailboxActions.island.tsx", "mail.mailbox", { mailboxId: "Targ01" }],
  ["Notebooks", "notebooks/src/frontend/[id]/_components/settings/AccessSection.tsx", "notebooks.notebook", { notebook: { id: "Targ01" } }],
  ["Notebooks admin", "notebooks/src/frontend/_components/AdminNotebookActions.island.tsx", "notebooks.notebook", { notebookId: "Targ01" }],
  ["Grids", "grids/src/frontend/_components/permissions/ScopedAccessSection.tsx", "grids.base", { scope: { type: "base", id: "Targ01" } }],
  [
    "Grids App",
    "grids/src/frontend/_components/permissions/ScopedAccessSection.tsx",
    "grids.base",
    { scope: { type: "customApp", id: "APP001", baseId: "Targ01" } },
  ],
  ["Grids admin", "grids/src/frontend/_components/AdminGridsActions.island.tsx", "grids.base", { baseId: "Targ01" }],
  ["Contacts", "contacts/src/frontend/_components/BookSettingsForm.tsx", "contacts.book", {}],
  ["Contacts admin", "contacts/src/frontend/_components/AdminBookActions.island.tsx", "contacts.book", { bookId: "Targ01" }],
  ["Pulse", "pulse/src/frontend/workspace/base-settings-dialog.tsx", "pulse.base", {}],
  ["Venue", "venue/src/frontend/_components/venue-workspace/settings.tsx", "venue.venue", {}],
  ["Files", "filesv2/src/frontend/Templates.tsx", "filesv2.template", {}],
  ["AI skill", "core/src/pages/admin/settings/_components/AiSkillAdminActions.island.tsx", "core.ai.skill", { skillId: "Targ01" }],
  ["AI project", "core/src/pages/admin/settings/_components/AiProjectAdminActions.island.tsx", "core.ai.project", { projectId: "Targ01" }],
  ["Assistant skill", "assistant/src/frontend/AssistantSkillsSettings.tsx", "core.ai.skill", {}],
  ["Assistant project", "assistant/src/frontend/AssistantProjectSettingsDialog.tsx", "core.ai.project", { project: { id: "Targ01" } }],
] as const;
/** How the real share entry edits access: the shared dialog, or an editable editor of its own inline. */
const shareEntry = (file: string) => {
  const source = readFileSync(resolve(import.meta.dir, "../../..", file), "utf8");
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let sharedDialog = false;
  let inlineEditor = false;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(tree) === "openAccessDialog") sharedDialog = true;
    const element = ts.isJsxElement(node) ? node.openingElement : ts.isJsxSelfClosingElement(node) ? node : undefined;
    const tag = element?.tagName.getText(tree);
    if (tag === "AccessDialog") sharedDialog = true;
    if (element && tag === "PermissionEditor") {
      // A read-only list (canEdit={false}) is no share path.
      const canEdit = element.attributes.properties.find(
        (attribute) => ts.isJsxAttribute(attribute) && attribute.name.getText(tree) === "canEdit",
      ) as ts.JsxAttribute | undefined;
      if (!canEdit || canEdit.initializer?.getText(tree) !== "{false}") inlineEditor = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return { sharedDialog, inlineEditor };
};
const appTarget = (file: string, props: object): CloudResourceRef => {
  const source = readFileSync(resolve(import.meta.dir, "../../..", file), "utf8");
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let target: ts.Expression | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && node.name.getText(tree) === "target") target ??= node.initializer;
    if (ts.isJsxAttribute(node) && node.name.getText(tree) === "target" && node.initializer && ts.isJsxExpression(node.initializer))
      target ??= node.initializer.expression;
    ts.forEachChild(node, visit);
  };
  visit(tree);
  if (!target) throw new Error(`${file}: the real share entry must supply its target`);
  const expression = ts.transpileModule(`return (${target.getText(tree)});`, {
    compilerOptions: { target: ts.ScriptTarget.ESNext },
  }).outputText;
  return new Function("props", "options", "currentVenue", "bookId", "item", "skill", "project", expression)(
    props,
    { base: { id: "Targ01" }, artifactId: "Targ01" },
    () => ({ id: "Targ01" }),
    () => "Targ01",
    { id: file.startsWith("filesv2/") ? "10000000-0000-4000-8000-000000000001" : "Targ01" },
    { id: "Targ01" },
    { id: "Targ01" },
  );
};

if (!isServer)
  for (const [label, file, type, props] of entries) {
    test(`${label}: the share entry offers Dienstkonto hinzufügen and adds an exact Kennung through its target by default`, async () => {
      // Every app shares through the shared dialog, so none keeps a parallel search, step or row layout (N1-mail-inline).
      if (file) expect(shareEntry(file)).toEqual({ sharedDialog: true, inlineEditor: false });
      const target = file ? appTarget(file, props) : { type, id: "Targ01" };
      expect(target).toEqual({ type, id: type === "filesv2.template" ? "10000000-0000-4000-8000-000000000001" : "Targ01" });
      const dom = createDomTestHarness();
      dom.document.documentElement.lang = "de";
      delegateEvents(["click", "input", "submit"], dom.document);
      const requests: URL[] = [];
      // The dialog also reads e-mails and the number of people from the directory; a handle lookup is a search.
      const lookups = () => requests.filter((url) => url.searchParams.has("search"));
      const grants: string[] = [];
      const fetch = spyOn(globalThis, "fetch").mockImplementation(
        Object.assign(
          async (input: RequestInfo | URL) => {
            const url = new URL(String(input), "https://cloud.example.test");
            requests.push(url);
            return Response.json({
              items: [
                {
                  kind: "service_account",
                  serviceAccount: {
                    id: accountId,
                    kind: "code",
                    name: "Code von info@beispiel.de",
                    handle,
                    description: "Dienstkonto eines Postfachs",
                  },
                },
              ],
            });
          },
          { preconnect: globalThis.fetch.preconnect },
        ),
      );
      const { AccessDialog } = await import("./AccessDialog");
      const grantAccess = async (principal: AccessEntry["principal"], permission: "read" | "write" | "admin"): Promise<AccessEntry> => {
        expect(principal).toEqual({ type: "service_account", serviceAccountId: accountId });
        grants.push(permission);
        return {
          id: "new-grant",
          principal,
          permission,
          displayName: "Code von info@beispiel.de",
          serviceAccountKind: "code",
          createdAt: "2026-11-04T00:00:00Z",
        };
      };
      const dispose = render(
        () => (
          <AccessDialog
            target={target}
            resourceName={label}
            initialEntries={[manager]}
            grantAccess={grantAccess}
            updateAccess={async () => {}}
            revokeAccess={async () => {}}
            close={() => {}}
          />
        ),
        dom.root,
      );
      const button = (text: string) =>
        Array.from(dom.root.querySelectorAll<HTMLButtonElement>("button")).find(
          (node) => node.getAttribute("aria-label") === text || node.textContent?.trim() === text,
        );
      const hit = () =>
        Array.from(dom.root.querySelectorAll<HTMLButtonElement>("li button")).find((node) =>
          node.textContent?.includes("Code von info@beispiel.de"),
        );
      try {
        expect(dom.root.textContent).toContain("Dienstkonten");
        button("Dienstkonto hinzufügen")!.click();
        const field = dom.root.querySelector<HTMLInputElement>('input[aria-label="Kennung des Dienstkontos"]')!;
        field.value = "Code von info@beispiel.de";
        field.dispatchEvent(new Event("input", { bubbles: true }));
        field.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        await waitFor(() => dom.root.textContent?.includes("Kein Dienstkonto mit dieser Kennung") === true);
        expect(lookups()).toHaveLength(0);
        field.value = handle;
        field.dispatchEvent(new Event("input", { bubbles: true }));
        await waitFor(() => Boolean(hit()));
        expect(lookups()).toHaveLength(1);
        expect(lookups()[0]!.pathname).toBe("/api/accounts/entities");
        expect(Object.fromEntries(lookups()[0]!.searchParams)).toMatchObject({
          search: handle,
          target_type: type,
          target_id: target.id,
          kinds: "service_account",
          service_account_kinds: "code",
        });
        hit()!.click();
        expect(grants).toEqual([]);
        button("Speichern")!.click();
        await waitFor(() => grants.length === 1);
        expect(grants).toEqual(["write"]);
      } finally {
        dispose();
        fetch.mockRestore();
        dom.cleanup();
      }
    });
  }

if (!isServer)
  for (const expanded of [false, true]) {
    test(`PermissionEditor ${expanded ? "expanded" : "compact"} keeps its directory kind restriction for Code handles`, async () => {
      const dom = createDomTestHarness();
      delegateEvents(["input"], dom.document);
      const requests: URL[] = [];
      const fetch = spyOn(globalThis, "fetch").mockImplementation(
        Object.assign(
          async (input: RequestInfo | URL) => {
            requests.push(new URL(String(input), "https://cloud.example.test"));
            return Response.json({ items: [] });
          },
          { preconnect: globalThis.fetch.preconnect },
        ),
      );
      const { default: PermissionEditor } = await import("./PermissionEditor");
      const dispose = render(
        () => (
          <PermissionEditor
            target={{ type: "inventory.item", id: "Targ01" }}
            initialEntries={[manager]}
            expanded={expanded}
            canEdit
            serviceAccountKinds={["agent"]}
            grantAccess={async () => {
              throw new Error("A Code handle must not select an excluded kind");
            }}
            updateAccess={async () => {}}
            revokeAccess={async () => {}}
          />
        ),
        dom.root,
      );
      try {
        installPopoverApi(dom.window as unknown as Window);
        const input = dom.root.querySelector<HTMLInputElement>("input[role=combobox]")!;
        input.value = handle;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        await waitFor(() => requests.length > 0);
        expect(requests).toHaveLength(1);
        expect(requests[0]!.searchParams.get("target_type")).toBeNull();
        expect(requests[0]!.searchParams.get("service_account_kinds")).toBe("agent");
        const results = dom.document.getElementById(input.getAttribute("aria-controls")!)!;
        expect(results.querySelectorAll('[role="option"]')).toHaveLength(0);
      } finally {
        dispose();
        fetch.mockRestore();
        dom.cleanup();
      }
    });
  }
