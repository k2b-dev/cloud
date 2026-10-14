import { expect, test } from "bun:test";
import type { SystemMessage } from "./service/contracts";
import { messagePreview, renderSystemMessage } from "./system-messages";

const member = { id: "12345678-1234-4234-8234-123456789012", name: "Lea" };
const cases: [SystemMessage, string, string][] = [
  [{ code: "conversation_created", params: {} }, "Alex created the chat.", "Alex hat den Chat erstellt."],
  [{ code: "details_changed", params: { name: "Plan" } }, "Alex renamed the chat to “Plan”.", "Alex hat den Chat in „Plan“ umbenannt."],
  [{ code: "details_changed", params: { name: null } }, "Alex removed the chat name.", "Alex hat den Chatnamen entfernt."],
  ...[{ icon: null }, { purpose: "Work" }, { icon: "ti ti-message", purpose: null }].flatMap(
    (details): [SystemMessage, string, string][] => [
      [
        { code: "details_changed", params: { name: "Plan", ...details } },
        "Alex renamed the chat to “Plan” and changed the chat details.",
        "Alex hat den Chat in „Plan“ umbenannt und die Chat-Angaben geändert.",
      ],
      [
        { code: "details_changed", params: { name: null, ...details } },
        "Alex removed the chat name and changed the chat details.",
        "Alex hat den Chatnamen entfernt und die Chat-Angaben geändert.",
      ],
    ],
  ),
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

for (const [names, en, de] of [
  [["Red"], "Alex added the group Red.", "Alex hat die Gruppe Red hinzugefügt."],
  [["Red", "Blue"], "Alex added the groups Red and Blue.", "Alex hat die Gruppen Red und Blue hinzugefügt."],
  [
    ["Red", "Blue", "Green", "Gold", "Pink"],
    "Alex added the groups Red, Blue, Green, and 2 others.",
    "Alex hat die Gruppen Red, Blue, Green und 2 weitere hinzugefügt.",
  ],
] as const)
  test(`groups_added with ${names.length} groups in EN and DE`, () => {
    const system: SystemMessage = { code: "groups_added", params: { groups: names.map((name) => ({ ...member, name })) } };
    expect(renderSystemMessage(system, "Alex", "en")).toBe(en);
    expect(renderSystemMessage(system, "Alex", "de")).toBe(de);
  });
test("group removal and automatic succession render in EN and DE", () => {
  const removed: SystemMessage = { code: "group_removed", params: { group: member } };
  expect(renderSystemMessage(removed, "Alex", "en")).toBe("Alex removed the group Lea.");
  expect(renderSystemMessage(removed, "Alex", "de")).toBe("Alex hat die Gruppe Lea entfernt.");
  const assigned: SystemMessage = { code: "manager_assigned", params: { member } };
  expect(renderSystemMessage(assigned, "Alex", "en")).toBe(
    "Lea now manages this chat because the account of its last manager was deleted.",
  );
  expect(renderSystemMessage(assigned, "Alex", "de")).toBe(
    "Lea verwaltet diesen Chat jetzt, weil das Konto der letzten verwaltenden Person gelöscht wurde.",
  );
});
