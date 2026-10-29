import { expect, test } from "bun:test";
import { isServer } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";

test.skipIf(isServer)(
  "the assignee picker offers adding or removing me and removing everyone first, searches the mailbox, and works by keyboard",
  async () => {
    const dom = createDomTestHarness();
    dom.root.className = "k2b-ui";
    dom.document.documentElement.lang = "en";
    const originalFetch = globalThis.fetch;
    const requests: string[] = [];
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        const url = new URL(String(input), "http://localhost");
        requests.push(`${url.pathname}?${url.searchParams}`);
        const users = [
          { id: "me-0000", uid: "valentin", displayName: "Valentin", avatarHash: null, permission: "admin", description: "valentin" },
          { id: "maria-01", uid: "maria", displayName: "Maria Muster", avatarHash: "abc", permission: "write", description: "maria" },
          {
            id: "agent-01",
            uid: "Mail Agent",
            displayName: "Mail Agent",
            avatarHash: null,
            permission: "write",
            description: "Mail Agent",
            type: "service_account",
            serviceAccountKind: "agent",
          },
          {
            id: "service-01",
            uid: "Mail Service",
            displayName: "Mail Service",
            avatarHash: null,
            permission: "write",
            description: "Mail Service",
            type: "service_account",
            serviceAccountKind: "standalone",
          },
        ].filter(
          (user) =>
            !url.searchParams.get("search") || user.displayName.toLowerCase().includes(url.searchParams.get("search")!.toLowerCase()),
        );
        return Response.json(users);
      },
      { preconnect: originalFetch.preconnect },
    );
    const { chooseMailAssignee } = await import("./mail-assign-picker");
    const options = () => Array.from(dom.document.querySelectorAll<HTMLElement>("[role='option']"));
    // A resolved dialog animates out before the next one opens.
    const closed = async () => {
      for (let attempt = 0; attempt < 50 && dom.document.querySelector("[role='combobox']"); attempt += 1) await Bun.sleep(20);
    };
    const optionTexts = () =>
      options().map((option) =>
        [option.querySelector("strong")?.textContent, option.querySelector("small")?.textContent].filter(Boolean).join(" "),
      );
    try {
      const first = chooseMailAssignee({ mailboxId: "Box001", currentUserId: "me-0000" });
      await Bun.sleep(400);
      expect(requests[0]).toBe("/api/mail/mailboxes/Box001/assignable-users?limit=50");
      expect(optionTexts()).toEqual([
        "Assign to me",
        "Remove me",
        "Remove all assignees",
        "Maria Muster maria",
        "Mail Agent Mail Agent",
        "Mail Service Mail Service",
      ]);
      expect(options()[3]!.querySelector("img")?.getAttribute("src")).toBe("/api/accounts/users/maria-01/avatar?rev=abc");
      const input = dom.document.querySelector<HTMLInputElement>("[role='combobox']")!;
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      expect(await first).toEqual({ mode: "add", userId: "me-0000", name: null });
      await closed();

      const second = chooseMailAssignee({ mailboxId: "Box001", currentUserId: "me-0000" });
      await Bun.sleep(400);
      const searchInput = dom.document.querySelector<HTMLInputElement>("[role='combobox']")!;
      searchInput.value = "mari";
      searchInput.dispatchEvent(new Event("input", { bubbles: true }));
      await Bun.sleep(400);
      expect(requests.at(-1)).toBe("/api/mail/mailboxes/Box001/assignable-users?search=mari&limit=50");
      expect(optionTexts()).toEqual(["Maria Muster maria"]);
      searchInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      expect(await second).toEqual({ mode: "add", userId: "maria-01", name: "Maria Muster" });
      await closed();

      const third = chooseMailAssignee({ mailboxId: "Box001", currentUserId: "me-0000" });
      await Bun.sleep(400);
      const thirdInput = dom.document.querySelector<HTMLInputElement>("[role='combobox']")!;
      thirdInput.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      thirdInput.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      thirdInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      expect(await third).toEqual({ mode: "replace", userId: null, name: null });
      await closed();

      for (const [name, id] of [
        ["Mail Agent", "agent-01"],
        ["Mail Service", "service-01"],
      ] as const) {
        const selected = chooseMailAssignee({ mailboxId: "Box001", currentUserId: "me-0000" });
        await Bun.sleep(400);
        const search = dom.document.querySelector<HTMLInputElement>("[role='combobox']")!;
        search.value = name!;
        search.dispatchEvent(new Event("input", { bubbles: true }));
        await Bun.sleep(400);
        expect(optionTexts()).toEqual([`${name} ${name}`]);
        expect(options()[0]!.querySelector("img")).toBeNull();
        expect(options()[0]!.querySelector(id === "agent-01" ? ".ti-robot" : ".ti-key")).not.toBeNull();
        search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        expect(await selected).toEqual({ mode: "add", userId: id, name });
        await closed();
      }

      dom.document.documentElement.lang = "de";
      const german = chooseMailAssignee({ mailboxId: "Box001", currentUserId: "me-0000" });
      await Bun.sleep(400);
      expect(dom.document.querySelector("[role='combobox']")?.getAttribute("placeholder")).toBe("Personen und Konten suchen...");
      expect(optionTexts().slice(0, 3)).toEqual(["Mir zuweisen", "Mich entfernen", "Alle Zuweisungen entfernen"]);
      dom.document
        .querySelector<HTMLInputElement>("[role='combobox']")!
        .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      expect(await german).toEqual({ mode: "add", userId: "me-0000", name: null });
    } finally {
      globalThis.fetch = originalFetch;
      dom.cleanup();
    }
  },
);
