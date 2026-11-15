import { expect, test } from "bun:test";
import { contextTab, fileTab, webTab, workspaceTabFromKey, workspaceTabId } from "./workspace-state";

test("a tab has a stable Panes id, and stored keys open again, also the reading view and the context tab", () => {
  const web = webTab("chat-one", "https://paketdienst.example/versand/frankreich", "Versand nach Frankreich")!;
  expect(workspaceTabId(web.key)).toMatch(/^[a-z][a-z0-9_-]*$/);
  expect(workspaceTabId(web.key)).toBe(workspaceTabId(webTab("chat-one", "https://paketdienst.example/versand/frankreich")!.key));
  expect(workspaceTabId(web.key)).not.toBe(workspaceTabId(fileTab("chat-one", "/a.pdf").key));
  expect(workspaceTabFromKey(web.key, "Versand nach Frankreich")).toMatchObject({ kind: "web", url: web.kind === "web" ? web.url : "" });
  expect(workspaceTabFromKey(contextTab("chat-one", "context", "Kontext").key, "")).toMatchObject({ kind: "context", category: "context" });
  // Only web addresses open as a reading view.
  expect(workspaceTabFromKey(JSON.stringify(["web", "chat-one", "javascript:alert(1)"]), "")).toBeNull();
  expect(workspaceTabFromKey("not json", "")).toBeNull();
});

test("web tabs accept only absolute HTTP and HTTPS addresses", () => {
  for (const url of [
    "javascript:void(0)",
    "data:text/plain,hello",
    "file:///a",
    "mailto:a@example.test",
    "/relative",
    "https://",
    "https://user:pass@example.test/",
  ]) {
    expect(webTab("chat-one", url)).toBeNull();
    expect(workspaceTabFromKey(JSON.stringify(["web", "chat-one", url]), "")).toBeNull();
  }
  for (const url of ["http://example.test/a", "https://example.test/a", "HTTPS://example.test/a"]) {
    expect(webTab("chat-one", url)).toMatchObject({ kind: "web", url });
    expect(workspaceTabFromKey(JSON.stringify(["web", "chat-one", url]), "")).toMatchObject({ kind: "web", url });
  }
});
