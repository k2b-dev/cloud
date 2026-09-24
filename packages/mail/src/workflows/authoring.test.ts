import { describe, expect, test } from "bun:test";
import { buildMailWorkflowCompletions } from "./authoring";
import { buildMailWorkflowCatalog } from "./catalog";

const catalog = buildMailWorkflowCatalog({
  folders: [{ id: "folder-1", name: "Team inbox" }],
  assignableUsers: [{ id: "user-1", name: "Ada" }],
  senderIdentities: [{ id: "sender-1", name: "Support <support@example.test>" }],
  localTags: [{ id: "tag-1", name: "Follow up" }],
  notificationUsers: [{ id: "user-2", name: "Grace" }],
});

describe("Mail workflow authoring completions", () => {
  test("returns mailbox-scoped catalog values for binding fields", () => {
    const source = "steps:\n  - moveMessage:\n      folder: Team";
    expect(buildMailWorkflowCompletions(source, source.length, catalog)).toEqual([
      {
        label: "Team inbox",
        kind: "source",
        detail: "folder-1",
        insertText: '"Team inbox"',
        textEdit: {
          start: source.indexOf("Team"),
          end: source.length,
          text: '"Team inbox"',
        },
      },
    ]);
  });

  test("labels folders by path and inserts the ID when the name is ambiguous", () => {
    const folders = buildMailWorkflowCatalog({
      folders: [
        { id: "folder-1", name: "Archiv", path: "Projekte / 2025 / Archiv" },
        { id: "folder-2", name: "Archiv", path: "Projekte / 2024 / Archiv" },
        { id: "folder-3", name: "Team inbox", path: "Team inbox" },
      ],
      assignableUsers: [],
    });
    const source = "steps:\n  - moveMessage:\n      folder: ";
    expect(buildMailWorkflowCompletions(source, source.length, folders).map(({ label, insertText }) => [label, insertText])).toEqual([
      ["Projekte / 2025 / Archiv", '"folder-1"'],
      ["Projekte / 2024 / Archiv", '"folder-2"'],
      ["Team inbox", '"Team inbox"'],
    ]);
  });

  test("combines assignable and notification users without duplicate ids", () => {
    const source = "steps:\n  - notify:\n      user: ";
    expect(buildMailWorkflowCompletions(source, source.length, catalog).map((item) => item.label)).toEqual(["Ada", "Grace"]);
  });
});
