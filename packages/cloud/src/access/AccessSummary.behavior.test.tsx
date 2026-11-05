import { describe, expect, test } from "bun:test";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";
import type { AccessEntry } from "../contracts/shared";

const entry = (id: string, principal: AccessEntry["principal"], permission: AccessEntry["permission"], extra: Partial<AccessEntry> = {}) =>
  ({ id, principal, permission, createdAt: "2026-11-05T00:00:00.000Z", ...extra }) satisfies AccessEntry;
const mia = entry("1", { type: "user", userId: "u1" }, "admin", { displayName: "Mia Hoffmann" });
const logistik = entry("2", { type: "group", groupId: "g1" }, "write", { displayName: "Logistik" });
const lagerbot = entry("3", { type: "service_account", serviceAccountId: "s1" }, "read", {
  displayName: "Lagerbot",
  serviceAccountKind: "agent",
});
// Code's own account; the kind arrives with the code lane, so the contract type does not list it yet.
const code = (id: string) =>
  ({
    ...entry(id, { type: "service_account", serviceAccountId: `c${id}` }, "write", { displayName: `Code ${id}` }),
    serviceAccountKind: "code",
  }) as unknown as AccessEntry;
const apiKey = entry("6", { type: "service_account", serviceAccountId: "k1" }, "read", {
  displayName: "Einkauf 2027",
  serviceAccountKind: "resource_bound",
});

describe("AccessSummary", () => {
  if (isServer) {
    test.skip("runs with browser export conditions", () => {});
    return;
  }

  const renderSummary = async (lang: string, props: import("solid-js").ComponentProps<typeof import("./AccessSummary").AccessSummary>) => {
    const dom = createDomTestHarness();
    dom.document.documentElement.lang = lang;
    const { AccessSummary } = await import("./AccessSummary");
    const dispose = render(() => <AccessSummary {...props} />, dom.root);
    const line = () => dom.root.querySelector("p")?.textContent ?? "";
    const listed = () =>
      Array.from(dom.root.querySelectorAll(".k2b-avatar-stack__row-copy")).map((row) => row.textContent?.replace(/\s+/g, " ").trim());
    return { dom, line, listed, cleanup: () => (dispose(), dom.cleanup()) };
  };

  test("counts people, groups and agents, General and service accounts as in the mockup", async () => {
    const ui = await renderSummary("de", { entries: [mia, logistik, lagerbot, code("4"), apiKey] });
    try {
      // An object's account belongs to its API keys, which have their own section.
      expect(ui.line()).toBe("3 Personen, Gruppen und Agenten · Alle angemeldeten Personen: aus · 1 Dienstkonto");
      // The faces open the full list with each level, so nobody opens the editor only to read it.
      expect(ui.listed()).toEqual(["Mia HoffmannVerwalten", "LogistikBearbeiten", "LagerbotAgentAnsehen"]);
      const trigger = ui.dom.root.querySelector<HTMLButtonElement>("button.k2b-avatar-stack__trigger")!;
      expect(trigger.getAttribute("aria-label")).toBe("Wer Zugriff hat: Mia Hoffmann und 2 weitere");
      // The faces are the button that opens exactly this list.
      expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
      const list = ui.dom.document.getElementById(trigger.getAttribute("aria-controls") ?? "");
      expect(list?.querySelectorAll(".k2b-avatar-stack__row-copy")).toHaveLength(3);
    } finally {
      ui.cleanup();
    }
  });

  test("a part without entries is left out, and two service accounts read in the plural", async () => {
    const ui = await renderSummary("de", { entries: [mia, code("4"), code("5")] });
    try {
      expect(ui.line()).toBe("1 Person, Gruppe oder Agent · Alle angemeldeten Personen: aus · 2 Dienstkonten");
    } finally {
      ui.cleanup();
    }
  });

  test("General shows its level in the app's words; denied and shadowed grants do not count", async () => {
    const signedIn = entry("7", { type: "authenticated" }, "read");
    const visitors = entry("8", { type: "public" }, "read");
    const leaDenied = entry("9", { type: "user", userId: "u2" }, "none", { displayName: "Lea Schmitt" });
    const ben = entry("10", { type: "user", userId: "u3" }, "write", { displayName: "Ben Albers" });
    const benDenied = entry("11", { type: "user", userId: "u3" }, "none", { displayName: "Ben Albers" });
    const unshadowed = (entries: readonly AccessEntry[]) => {
      const denied = new Set(entries.filter((stored) => stored.permission === "none").map((stored) => JSON.stringify(stored.principal)));
      return entries.filter((stored) => !denied.has(JSON.stringify(stored.principal)));
    };
    const ui = await renderSummary("en", {
      entries: [mia, signedIn, visitors, leaDenied, ben, benDenied],
      allowedLevels: [{ level: "read", label: "Use" }, "write", "admin"],
      effectiveEntries: unshadowed,
    });
    try {
      expect(ui.line()).toBe("1 person, group or agent · All signed-in people: Use · Public: Use");
      expect(ui.listed()).toEqual(["Mia HoffmannManage"]);
    } finally {
      ui.cleanup();
    }
  });

  test("someone with several grants counts once, at the strongest, also for General", async () => {
    const miaRead = entry("12", { type: "user", userId: "u1" }, "read", { displayName: "Mia Hoffmann" });
    const miaAssigned = entry("13", { type: "user", userId: "u1" }, "admin", { displayName: "Mia Hoffmann", scope: "assigned" });
    const signedInRead = entry("14", { type: "authenticated" }, "read");
    const signedInEdit = entry("15", { type: "authenticated" }, "write");
    const ui = await renderSummary("en", { entries: [miaRead, mia, miaAssigned, signedInRead, signedInEdit] });
    try {
      expect(ui.line()).toBe("1 person, group or agent · All signed-in people: Edit");
      expect(ui.listed()).toEqual(["Mia HoffmannManage"]);
    } finally {
      ui.cleanup();
    }
  });

  test("with nobody listed there are no faces, only the line", async () => {
    const ui = await renderSummary("en", { entries: [] });
    try {
      expect(ui.dom.root.querySelector(".k2b-avatar-stack")).toBeNull();
      expect(ui.line()).toBe("0 people, groups and agents · All signed-in people: off");
    } finally {
      ui.cleanup();
    }
  });
});
