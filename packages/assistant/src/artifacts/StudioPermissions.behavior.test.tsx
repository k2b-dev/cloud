import { describe, expect, mock, spyOn, test } from "bun:test";
import type { AccessEntry } from "@k2b/cloud/contracts";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";
import type { StudioAccessOptions } from "./StudioPermissions";

const waitFor = async (condition: () => boolean, label: string) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${label}`);
};

const owner: AccessEntry = {
  id: "00000000-0000-4000-8000-000000000001",
  principal: { type: "user", userId: "10000000-0000-4000-8000-000000000001" },
  permission: "admin",
  displayName: "Mia Hoffmann",
  createdAt: "2026-11-04T12:00:00.000Z",
};
const mailboxCode: AccessEntry = {
  id: "00000000-0000-4000-8000-000000000002",
  principal: { type: "service_account", serviceAccountId: "20000000-0000-4000-8000-000000000002" },
  permission: "read",
  displayName: "Code von einkauf@beispiel.de",
  serviceAccountKind: "code",
  serviceAccountDescription: "Dienstkonto eines Postfachs",
  createdAt: "2026-11-04T12:00:00.000Z",
};
const publicEntry: AccessEntry = {
  id: "00000000-0000-4000-8000-000000000003",
  principal: { type: "public" },
  permission: "read",
  createdAt: "2026-11-04T12:00:00.000Z",
};

describe("Studio sharing in the shared access dialog", () => {
  if (isServer) {
    test.skip("runs with browser export conditions", () => {});
    return;
  }

  const setup = async (overrides: Partial<StudioAccessOptions> & { lang?: string } = {}) => {
    const dom = createDomTestHarness();
    dom.document.documentElement.lang = overrides.lang ?? "de";
    delegateEvents(["click", "input"], dom.document);
    // Machine rights and machine secrets load on their own; this app has none.
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => Response.json([])) as unknown as typeof fetch);
    const { AccessDialog } = await import("@k2b/cloud/access/ui");
    const { studioAccessDialogProps } = await import("./StudioPermissions");
    const { prompts } = await import("@k2b/ui");
    const confirm = spyOn(prompts, "confirm").mockResolvedValue(true);
    const calls: string[] = [];
    const close = mock((_saved: boolean) => {});
    const props = studioAccessDialogProps({
      artifactId: "App234",
      title: "Angebotsrechner",
      published: true,
      locale: overrides.lang ?? "de",
      viewerUserId: owner.principal.type === "user" ? owner.principal.userId : undefined,
      entries: [owner, mailboxCode],
      loadProjects: async () => [],
      grant: async (principal, level) => {
        calls.push(`grant ${principal.type} ${level}`);
        return { id: "00000000-0000-4000-8000-000000000009", principal, permission: level, createdAt: "2026-11-04T12:00:00.000Z" };
      },
      change: async (id, level) => {
        calls.push(`change ${id.slice(-1)} ${level}`);
      },
      ...overrides,
    });
    const dispose = render(() => <AccessDialog {...props} close={close} />, dom.root);
    const row = (name: string) => Array.from(dom.root.querySelectorAll("li")).find((item) => item.textContent?.includes(name))!;
    const button = (text: string) =>
      Array.from(dom.root.querySelectorAll<HTMLButtonElement>("button")).find((item) => item.textContent?.trim() === text)!;
    const section = (title: string) =>
      Array.from(dom.root.querySelectorAll("section")).find((item) => item.querySelector("h3")?.textContent?.startsWith(title))!;
    return {
      dom,
      calls,
      close,
      row,
      button,
      section,
      cleanup: async () => {
        // Machine rights and secrets finish loading before the document goes away.
        await waitFor(() => !dom.root.textContent?.includes("…"), "machine rights");
        dispose();
        confirm.mockRestore();
        fetchSpy.mockRestore();
        dom.cleanup();
      },
    };
  };

  test("a Code account sits under Dienstkonten with its type, Use only, and the sentence about who acts with its right", async () => {
    const ui = await setup();
    try {
      const services = ui.section("Dienstkonten");
      expect(services.textContent).toContain("Code von einkauf@beispiel.de");
      expect(ui.row("Code von einkauf@beispiel.de").textContent).toContain("Dienstkonto eines Postfachs");
      expect(services.textContent?.match(/Wer den Code bearbeitet, handelt mit diesem Recht\./g)).toHaveLength(1);
      const levels = Array.from(ui.row("Code von einkauf@beispiel.de").querySelectorAll('[role="option"]')).map((node) =>
        node.textContent?.trim(),
      );
      expect(levels).toEqual(["Benutzen"]);
      // People keep both Studio levels.
      const ownerLevels = Array.from(ui.row("Mia Hoffmann").querySelectorAll('[role="option"]')).map((node) => node.textContent ?? "");
      expect(ownerLevels.map((label) => label.slice(0, label.startsWith("Benutzen") ? 8 : 9))).toEqual(["Benutzen", "Verwalten"]);
      expect(ui.section("Personen").textContent).not.toContain("Code von");
    } finally {
      await ui.cleanup();
    }
  });

  test("a Code account's row in the shared dialog never offers Verwalten", async () => {
    const ui = await setup();
    try {
      const options = Array.from(ui.row("Code von einkauf@beispiel.de").querySelectorAll('[role="option"]')).map(
        (node) => node.textContent ?? "",
      );
      expect(options.length).toBeGreaterThan(0);
      expect(options.some((label) => label.includes("Verwalten"))).toBe(false);
    } finally {
      await ui.cleanup();
    }
  });

  test("a Code account's row shows the code icon in the square service-account avatar", async () => {
    const ui = await setup();
    try {
      expect(ui.row("Code von einkauf@beispiel.de").querySelector('[data-shape="square"] .ti-code')).not.toBeNull();
    } finally {
      await ui.cleanup();
    }
  });

  test("without a Code account the sentence is absent, and the section still offers adding one by its identifier", async () => {
    const ui = await setup({ entries: [owner] });
    try {
      const services = ui.section("Dienstkonten");
      expect(services.textContent).not.toContain("Wer den Code bearbeitet");
      expect(ui.button("Dienstkonto hinzufügen")).toBeDefined();
    } finally {
      await ui.cleanup();
    }
  });

  test("a Code account added by its identifier gets Use on Save, through the normal grant", async () => {
    const lookups: string[] = [];
    const ui = await setup({
      entries: [owner],
      findServiceAccount: async (handle) => {
        lookups.push(handle);
        return {
          principal: { type: "service_account", serviceAccountId: "20000000-0000-4000-8000-000000000004" },
          display: { displayName: "Code von info@beispiel.de", serviceAccountKind: "code" },
        };
      },
    });
    try {
      ui.button("Dienstkonto hinzufügen").click();
      const input = ui.dom.root.querySelector<HTMLInputElement>('input[aria-label="Kennung des Dienstkontos"]')!;
      input.value = "code-7k2q9m4xwt";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      ui.button("Suchen").click();
      await waitFor(() => Boolean(ui.button("Hinzufügen")), "the found account");
      expect(lookups).toEqual(["code-7k2q9m4xwt"]);
      ui.button("Hinzufügen").click();
      expect(ui.row("Code von info@beispiel.de").textContent).toContain("Neu");
      expect(ui.section("Dienstkonten").textContent).toContain("Wer den Code bearbeitet, handelt mit diesem Recht.");
      expect(ui.calls).toEqual([]);
      ui.button("Speichern").click();
      await waitFor(() => ui.close.mock.calls.length === 1, "the saved dialog");
      expect(ui.calls).toEqual(["grant service_account read"]);
    } finally {
      await ui.cleanup();
    }
  });

  test("machine rights load only inside the dialog, and sharing never opens after its page is gone", async () => {
    const dom = createDomTestHarness();
    dom.document.documentElement.lang = "en";
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((() => new Promise<Response>(() => {})) as unknown as typeof fetch);
    const { AccessDialog } = await import("@k2b/cloud/access/ui");
    const { studioAccessDialogProps } = await import("./StudioPermissions");
    const { createArtifactActions } = await import("./artifact-actions");
    const { artifactClient } = await import("./client");
    const ui = await import("@k2b/ui");
    const { createRoot } = await import("solid-js");
    const open = spyOn(ui.dialogCore, "open");
    const access = Promise.withResolvers<AccessEntry[]>();
    const accessSpy = spyOn(artifactClient, "access").mockReturnValue(access.promise);
    try {
      const props = studioAccessDialogProps({
        artifactId: "App234",
        title: "Angebotsrechner",
        published: true,
        locale: "en",
        entries: [owner],
        loadProjects: async () => [],
        grant: async () => null,
        change: async () => {},
      });
      // Building the dialog's props starts nothing; the dialog owns the requests of its sections.
      expect(fetchSpy).not.toHaveBeenCalled();
      const dispose = render(() => <AccessDialog {...props} close={() => {}} />, dom.root);
      expect(fetchSpy.mock.calls.length).toBeGreaterThan(0);
      dispose();

      const actions = createRoot((disposeActions) => ({ disposeActions, ...createArtifactActions({ userId: "owner" }) }));
      const share = actions
        .menu({
          id: "App234",
          kind: "app",
          title: "Angebotsrechner",
          description: "",
          revision: 1,
          publishedRevision: 1,
          permission: "admin",
          updatedAt: "",
          forkedFromId: null,
          forkedFromRevision: null,
        })
        .find((entry) => "label" in entry && entry.label === "Manage access");
      if (!share || !("action" in share) || !share.action) throw new Error("Missing share action");
      const pending = share.action();
      await waitFor(() => accessSpy.mock.calls.length === 1, "the access list request");
      actions.disposeActions();
      access.resolve([owner]);
      await pending;
      expect(open).not.toHaveBeenCalled();
    } finally {
      open.mockRestore();
      accessSpy.mockRestore();
      fetchSpy.mockRestore();
      dom.cleanup();
    }
  });

  test("a failed project list keeps sharing usable and offers to try again", async () => {
    let attempts = 0;
    const ui = await setup({
      lang: "en",
      loadProjects: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("unavailable");
        return [{ projectId: "project", shortId: "project", name: "Finance team" }];
      },
    });
    try {
      await waitFor(() => ui.dom.root.textContent?.includes("Could not load this content") === true, "the project error");
      expect(ui.button("Add service account")).toBeDefined();
      ui.button("Try again").click();
      await waitFor(() => ui.dom.root.textContent?.includes("Finance team") === true, "the projects");
    } finally {
      await ui.cleanup();
    }
  });

  test("Studio notes, project access and machine rights stay in the dialog; a stored public link explains it is switched off", async () => {
    const ui = await setup({
      lang: "en",
      published: false,
      entries: [owner, publicEntry],
      loadProjects: async () => [
        { projectId: "project", shortId: "project", name: "Finance team" },
        { projectId: "private", shortId: null, name: null },
      ],
    });
    try {
      const text = () => ui.dom.root.textContent ?? "";
      expect(text()).toContain("Cloud access by this app");
      expect(text()).toContain("Not published yet");
      expect(text()).toContain("Access through projects");
      expect(text()).toContain("Finance team");
      expect(text()).toContain("Project without access to its details");
      // PUBLIC_APP_SHARING is off: the stored entry stays visible under General so a manager can turn it off.
      expect(text()).toContain("Public links are switched off");
      expect(ui.dom.root.querySelector('input[aria-label="Public with link"]')).not.toBeNull();
      await waitFor(() => text().includes("No agents or service accounts have access."), "the machine rights");
      expect(text()).toContain("Agents added above appear here once saved.");
    } finally {
      await ui.cleanup();
    }
  });
});
