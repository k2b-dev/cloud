import { expect, test } from "bun:test";
import { UniversalSearchDataSchema } from "@k2b/cloud/contracts";
import type { ArtifactIdentity, ArtifactSummary } from "./artifacts/service";
import { testIdentity } from "./artifacts/test-identity";
import { assistantCapabilities } from "./capabilities";
import { assistantAppsSearchOptions, assistantSearchOptions } from "./frontend/assistant-search";
import { searchAssistantApps } from "./search";

const context = { ...testIdentity("owner"), locale: "de" };
const app: ArtifactSummary = {
  id: "App001",
  kind: "app",
  title: "Banking",
  description: "Rechnungen",
  revision: 1,
  publishedRevision: 1,
  permission: "read",
  updatedAt: "",
  forkedFromId: null,
  forkedFromRevision: null,
};

test("Studio search delegates identity, query and bound to the authorized catalog and links to app details", async () => {
  const result = await searchAssistantApps({ query: "Rechnungen", tags: ["studio-app"], limit: 80 }, context, {
    list: async (identity: ArtifactIdentity, page, query, limit) => {
      expect(identity).toBe(context);
      expect([page, query, limit]).toEqual([1, "Rechnungen", 80]);
      return { items: [app], page: 1, hasNext: false };
    },
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(UniversalSearchDataSchema.safeParse(result.data.data).success).toBe(true);
  expect(result.data.data[0]).toMatchObject({
    ref: { type: "assistant.app", id: "App001" },
    preview: "Rechnungen",
    links: [{ rel: "open", href: "/app/assistant/apps/App001" }],
  });
});

test("Studio search rejects unsupported scopes and service identities before catalog access", async () => {
  const store = {
    list: async () => {
      throw new Error("must not read");
    },
  };
  const input = { query: "", tags: ["studio-app"], limit: 30 };
  expect((await searchAssistantApps({ ...input, scope: { type: "assistant.project", id: "Proj01" } }, context, store)).ok).toBe(false);
  expect(
    (await searchAssistantApps(input, { ...context, accessSubject: { type: "service_account", serviceAccountId: "svc" } }, store)).ok,
  ).toBe(false);
});

test("Studio search button uses the registered app search tag", () => {
  const tag = assistantCapabilities.queries["app.search"].universalSearch.tags[0].tag;
  expect(assistantAppsSearchOptions("de")).toEqual({
    query: "",
    scope: { appId: "assistant", tag, label: "Studio", icon: "ti ti-app-window" },
  });
});

test("all-chat search stays restricted to chats when projects and Studio also provide search", () => {
  expect(assistantSearchOptions("en")).toEqual({
    query: "",
    scope: { appId: "assistant", tag: "chat", label: "Chats", icon: "ti ti-messages" },
  });
  expect(assistantSearchOptions("en", { id: "Chat01", title: "Chat" })).toMatchObject({
    query: "",
    scope: { ref: { type: "assistant.chat", id: "Chat01" } },
  });
});
