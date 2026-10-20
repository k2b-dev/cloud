import { expect, test } from "bun:test";
import type { AccessEntry } from "@k2b/cloud/contracts/shared";
import { isServer } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";

const domTest = isServer ? test.skip : test;
const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const id = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`;

const appEntry = (n: number, principal: AccessEntry["principal"], displayName?: string) => ({
  id: id(n),
  principal,
  permission: "read" as const,
  createdAt: "2026-10-06T00:00:00.000Z",
  ...(displayName ? { displayName } : {}),
  resourceType: "customApp" as const,
  resourceId: id(100 + n),
  resourceName: `Board ${n}`,
  tableId: null,
  tableName: null,
});

for (const locale of ["en", "de"] as const) {
  domTest(`${locale}: Grids administration names app grantees without showing their IDs`, async () => {
    const dom = createDomTestHarness();
    dom.document.documentElement.lang = locale;
    try {
      const [{ openPermissionDialog }, { dialogCore }] = await Promise.all([import("./AdminGridsActions.island"), import("@k2b/ui")]);
      void openPermissionDialog({ baseId: id(90), baseName: "Projects" }, [
        appEntry(1, { type: "user", userId: id(2) }),
        appEntry(3, { type: "group", groupId: id(4) }),
        appEntry(5, { type: "service_account", serviceAccountId: id(6) }),
        appEntry(7, { type: "authenticated" }, "All users (incl. guests)"),
        appEntry(8, { type: "public" }, "Public"),
        appEntry(9, { type: "user", userId: id(10) }, "Quentin Dorn"),
      ]);
      try {
        const ready = () => dom.document.querySelector("dialog")?.textContent?.includes("Board 9") ?? false;
        for (let attempt = 0; attempt < 150 && !ready(); attempt++) await Bun.sleep(10);
        expect(ready()).toBe(true);
        const dialog = dom.document.querySelector("dialog")!;
        expect(dialog.textContent).not.toMatch(uuid);
        for (const element of dialog.querySelectorAll("[aria-label], [title]"))
          for (const attribute of ["aria-label", "title"]) expect(element.getAttribute(attribute) ?? "").not.toMatch(uuid);
        const expected =
          locale === "en"
            ? ["Unknown person", "Deleted group", "Unknown service account", "All users (including guests)", "Public", "Quentin Dorn"]
            : [
                "Unbekannte Person",
                "Gelöschte Gruppe",
                "Unbekanntes Dienstkonto",
                "Alle Benutzer einschließlich Gäste",
                "Öffentlich",
                "Quentin Dorn",
              ];
        for (const label of expected) expect(dialog.textContent).toContain(label);
        if (locale === "de") expect(dialog.textContent).not.toContain("All users (incl. guests)");
      } finally {
        dialogCore.close();
        await Bun.sleep(20);
      }
    } finally {
      dom.cleanup();
    }
  });
}
