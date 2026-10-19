import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { resolveMailSearchRoute } from "../../search-state";

const root = mkdtempSync(join(tmpdir(), "mail-head-render-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { MailboxHeadFilters } = await import("./MailWorkspaceHead");
const tag = {
  id: "Tag001",
  mailboxId: "Box001",
  name: "Invoices",
  color: "#0f766e",
  revision: 1,
  createdAt: "2026-10-14T10:00:00Z",
  updatedAt: "2026-10-14T10:00:00Z",
};
const filters = (expression: object, localTags = [tag]) => {
  const requestUrl = `/app/mail/Box001?${new URLSearchParams({ search: JSON.stringify({ expression, sort: "newest" }) })}`;
  return renderToString(() =>
    createComponent(MailboxHeadFilters, {
      requestUrl,
      search: resolveMailSearchRoute(new URL(requestUrl, "https://cloud.test")),
      folders: [],
      localTags,
      onOpenHref: () => {},
    }),
  );
};
test("head Tag chip names the selected tag, without displaying its ID or a second search chip", () => {
  const html = filters({ type: "local_tag_id", tagId: "Tag001" });
  expect(html).toContain("Invoices");
  expect(html).toContain("Tag");
  expect(html).not.toContain("Tag001");
  expect(html).not.toContain("Search");
});
test("head Search chip summarizes structured conditions, including deleted tags inside a group", () => {
  expect(filters({ type: "text", field: "from", query: "billing@example.test", match: "exact" })).toContain("billing@example.test");
  const deleted = filters({
    type: "and",
    expressions: [
      { type: "local_tag_id", tagId: "Gone01" },
      { type: "work_status", value: "needs_action" },
    ],
  });
  expect(deleted).toContain("Search");
  expect(deleted).toContain("deleted tag");
  expect(deleted).not.toContain("Gone01");
});
