import { expect, test } from "bun:test";
import type { SystemMessage } from "./service/contracts";
import { messagePreview, renderSystemMessage } from "./system-messages";

const member = { id: "12345678-1234-4234-8234-123456789012", name: "Lea" };
const cases: [SystemMessage, string, string][] = [
  [{ code: "conversation_created", params: {} }, "Alex created the chat.", "Alex hat den Chat erstellt."],
  [{ code: "details_changed", params: { name: "Plan" } }, "Alex renamed the chat to “Plan”.", "Alex hat den Chat in „Plan“ umbenannt."],
  [{ code: "details_changed", params: { name: null } }, "Alex removed the chat name.", "Alex hat den Chatnamen entfernt."],
  [
    { code: "details_changed", params: { icon: null, purpose: "Work" } },
    "Alex changed the chat details.",
    "Alex hat die Chat-Angaben geändert.",
  ],
  [{ code: "members_added", params: { members: [member] } }, "Alex added Lea.", "Alex hat Lea hinzugefügt."],
  [{ code: "member_removed", params: { member } }, "Alex removed Lea.", "Alex hat Lea entfernt."],
  [{ code: "member_left", params: {} }, "Alex left the chat.", "Alex hat den Chat verlassen."],
  [
    { code: "member_left", params: { successor: member } },
    "Alex left the chat and handed management to Lea.",
    "Alex hat den Chat verlassen und die Verwaltung an Lea übergeben.",
  ],
  ...(["read", "write", "admin"] as const).map((permission): [SystemMessage, string, string] => [
    { code: "permission_changed", params: { member, permission } },
    `Alex changed Lea's permission to ${{ read: "Read", write: "Write", admin: "Manage" }[permission]}.`,
    `Alex hat die Berechtigung von Lea auf ${{ read: "Lesen", write: "Schreiben", admin: "Verwalten" }[permission]} geändert.`,
  ]),
];
for (const [system, en, de] of cases)
  test(`${system.code} ${JSON.stringify(system.params)} renders in EN and DE`, () => {
    expect(renderSystemMessage(system, "Alex", "en")).toBe(en);
    expect(renderSystemMessage(system, "Alex", "de-DE")).toBe(de);
  });
test("member lists show up to four names, otherwise three and the count of the rest", () => {
  const four: SystemMessage = {
    code: "members_added",
    params: { members: ["Lea", "Tim", "Mia", "Ada"].map((name) => ({ ...member, name })) },
  };
  expect(renderSystemMessage(four, "Alex", "en")).toBe("Alex added Lea, Tim, Mia, and Ada.");
  const system: SystemMessage = {
    code: "members_added",
    params: { members: ["Lea", "Tim", "Mia", "Ada", "Tom"].map((name) => ({ ...member, name })) },
  };
  expect(renderSystemMessage(system, "Alex", "en")).toBe("Alex added Lea, Tim, Mia, and 2 others.");
  expect(renderSystemMessage(system, "Alex", "de")).toBe("Alex hat Lea, Tim, Mia und 2 weitere hinzugefügt.");
});
test("previews collapse whitespace and cut at 140 code points", () => {
  expect(messagePreview("  a\n\t b  ")).toBe("a b");
  expect(messagePreview("😀".repeat(141))).toBe("😀".repeat(140));
});
