import { expect, test } from "bun:test";
import { resolveChatFileLink } from "./chat-file-link";
import { workspaceSelectionFromHref } from "../artifacts/workspace-state";

const current = "http://localhost:3000/app/assistant?conversation=qxGsYe";
const paths = ["/files/inventar-uebersicht.md", "/Bericht mit ü.md"];

test("known file paths and same-origin URLs open a reloadable chat workspace", () => {
  for (const href of [paths[0]!, `http://localhost:3000${paths[0]}`, "/Bericht%20mit%20%C3%BC.md"]) {
    const result = resolveChatFileLink(href, current, "qxGsYe", paths)!;
    expect(result).not.toBeNull();
    expect(new URL(result.href, current).searchParams.get("conversation")).toBe("qxGsYe");
    expect(workspaceSelectionFromHref(result.href)).toMatchObject({ kind: "file", conversationId: "qxGsYe", path: result.path });
  }
});

test("unrelated links and files absent from this chat are unchanged", () => {
  for (const href of ["/app/grids/base", "/files/missing.md", "https://external.test/files/inventar-uebersicht.md", "//external.test/files/inventar-uebersicht.md", "javascript:alert(1)", "#section", "/files/inventar-uebersicht.md?download=1", "/bad%FF"]) {
    expect(resolveChatFileLink(href, current, "qxGsYe", paths)).toBeNull();
  }
  expect(resolveChatFileLink(paths[0]!, current, "other", [])).toBeNull();
});
