import { describe, expect, test } from "bun:test";
import type { CapabilityActionManifest, CapabilityQueryManifest } from "@k2b/cloud/contracts";
import type { SelectedCapability } from "./catalog";
import { resolveCapabilityDataPresentation } from "./result-presentation";

const querySelection = (universalSearch = true): SelectedCapability => ({
  app: { id: "mail", name: "Mail", icon: "ti ti-mail", description: "Mail" },
  kind: "query",
  operation: {
    localId: "search",
    title: "Search mail",
    description: "Search mail.",
    inputSchema: { type: "object" },
    dataSchema: { type: "array" },
    schemaHash: "a".repeat(64),
    openWorld: false,
    ...(universalSearch ? { universalSearch: { tags: [] } } : {}),
  } satisfies CapabilityQueryManifest,
});

const actionSelection: SelectedCapability = {
  app: { id: "contacts", name: "Contacts", icon: "ti ti-address-book", description: "Contacts" },
  kind: "action",
  operation: {
    localId: "create",
    title: "Create contact",
    description: "Create a contact.",
    inputSchema: { type: "object" },
    dataSchema: { type: "object" },
    schemaHash: "b".repeat(64),
    destructive: false,
    openWorld: false,
    idempotency: "required",
  } satisfies CapabilityActionManifest,
};

const searchData = [
  {
    ref: { type: "mail.message", id: "message-1" },
    title: "Quarterly planning",
    preview: "Agenda and next steps",
    icon: "ti ti-mail",
    metadata: [{ label: "Mailbox", value: "Operations" }],
    links: [{ rel: "open" as const, href: "/app/mail/inbox?message=message-1" }],
  },
];

describe("capability result presentation", () => {
  test("uses the standard resource view for a valid Universal Search result", () => {
    expect(resolveCapabilityDataPresentation(querySelection(), searchData)).toEqual({
      kind: "universal-search",
      items: searchData,
    });
  });

  test("falls back safely when a declared Universal Search result is malformed", () => {
    const malformed = [{ title: "Missing resource identity" }];
    expect(resolveCapabilityDataPresentation(querySelection(), malformed)).toEqual({ kind: "generic", data: malformed });
  });

  test("does not infer a standard view from data shape alone", () => {
    expect(resolveCapabilityDataPresentation(querySelection(false), searchData)).toEqual({ kind: "generic", data: searchData });
    expect(resolveCapabilityDataPresentation(actionSelection, searchData)).toEqual({ kind: "generic", data: searchData });
  });
});
