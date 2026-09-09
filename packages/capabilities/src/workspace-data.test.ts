import { describe, expect, test } from "bun:test";
import type { CapabilityActionManifest, CapabilityQueryManifest } from "@k2b/cloud/contracts";
import { capabilityOperationRows, paginateCapabilityOperations, parseCapabilityTableState } from "./workspace-data";

const query = (overrides: Partial<CapabilityQueryManifest> = {}): CapabilityQueryManifest => ({
  localId: "messages.search",
  title: "Search messages",
  description: "Find messages in a mailbox.",
  inputSchema: { type: "object" },
  dataSchema: { type: "object" },
  schemaHash: "query-schema",
  openWorld: false,
  ...overrides,
});

const action = (overrides: Partial<CapabilityActionManifest> = {}): CapabilityActionManifest => ({
  localId: "draft.create",
  title: "Create draft",
  description: "Create an editable mail draft.",
  inputSchema: { type: "object" },
  dataSchema: { type: "object" },
  schemaHash: "action-schema",
  idempotency: "none",
  destructive: false,
  openWorld: false,
  ...overrides,
});

describe("capability workspace data", () => {
  test("parses bounded URL-backed table state", () => {
    const state = parseCapabilityTableState(
      new URL("https://cloud.test/app/capabilities/mail?search=%20draft%20&sort=id&direction=desc&page=4"),
    );

    expect(state).toEqual({ search: "draft", sort: "id", direction: "desc", page: 4 });
  });

  test("falls back for unsupported sorting and invalid pages", () => {
    const state = parseCapabilityTableState(
      new URL("https://cloud.test/app/capabilities/mail?sort=unknown&direction=sideways&page=2later"),
    );

    expect(state).toEqual({ search: "", sort: "title", direction: "asc", page: 1 });
  });

  test("searches descriptions and sorts deterministically", () => {
    const operations = capabilityOperationRows(
      "mail",
      [query({ title: "Zulu", description: "Mailbox audit" })],
      [action({ title: "Alpha", description: "Mailbox audit" })],
    );
    const page = paginateCapabilityOperations(operations, {
      search: "audit",
      sort: "title",
      direction: "asc",
      page: 1,
    });

    expect(page.rows.map((row) => row.title)).toEqual(["Alpha", "Zulu"]);
    expect(page.total).toBe(2);
  });

  test("classifies action policy for display and sorting", () => {
    const operations = capabilityOperationRows(
      "mail",
      [query()],
      [action(), action({ localId: "mail.delete", title: "Delete mail", destructive: true })],
    );
    const page = paginateCapabilityOperations(operations, {
      search: "",
      sort: "policy",
      direction: "asc",
      page: 1,
    });

    expect(page.rows.map((row) => row.policy)).toEqual(["Destructive", "Read only", "Write"]);
  });
});
