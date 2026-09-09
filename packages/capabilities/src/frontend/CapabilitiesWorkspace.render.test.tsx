import { describe, expect, test } from "bun:test";
import type { CapabilityActionManifest, CapabilityQueryManifest } from "@k2b/cloud/contracts";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { SelectedCapability } from "../catalog";
import "./ssr-test-plugin";

const { default: CapabilitiesWorkspace } = await import("./CapabilitiesWorkspace.island.tsx");
const { default: CapabilityResultView } = await import("./CapabilityResultView");

const app = { id: "mail", name: "Mail", icon: "ti ti-mail", description: "Mail capabilities" };

const querySelection: SelectedCapability = {
  app,
  kind: "query",
  operation: {
    localId: "messages.search",
    title: "Search messages",
    description: "Find messages in a mailbox.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", title: "Query" } },
      required: ["query"],
    },
    dataSchema: { type: "object" },
    schemaHash: "a".repeat(64),
    openWorld: false,
  } satisfies CapabilityQueryManifest,
};

const actionSelection: SelectedCapability = {
  app,
  kind: "action",
  operation: {
    localId: "drafts.delete",
    title: "Delete draft",
    description: "Delete one draft.",
    inputSchema: { type: "object" },
    dataSchema: { type: "object" },
    schemaHash: "b".repeat(64),
    destructive: true,
    openWorld: true,
    idempotency: "required",
  } satisfies CapabilityActionManifest,
};

const renderWorkspace = (selection: SelectedCapability) =>
  renderToString(() =>
    createComponent(CapabilitiesWorkspace, {
      selection,
      closeHref: "/app/capabilities/mail?sort=title&page=2",
      initialAttemptKey: "attempt-1",
    }),
  );

const legacyDetailClasses = [
  'class="detail-header',
  'class="detail-stack',
  'class="detail-section',
  'class="detail-row',
  'class="detail-facts',
];

describe("Capabilities workspace detail panel", () => {
  test("composes a query runner through one shared detail-panel scroll owner", () => {
    const html = renderWorkspace(querySelection);

    expect(html).toContain('class="k2b-detail-panel"');
    expect(html).toContain("<h2>Search messages</h2>");
    expect(html).toContain("Find messages in a mailbox.");
    expect(html).toContain("mail.messages.search");
    expect(html).toContain('data-scroll-preserve="capability-mail-query-messages.search"');
    expect(html.match(/k2b-detail-panel__body/g)).toHaveLength(1);
    expect(html).toContain('role="group" aria-label="Capability run"');
    expect(html).toContain(">Request<");
    expect(html).toContain(">Response<");
    expect(html).toContain("Ready to run");
    expect(html).toContain("Request as cURL");
    expect(html).toContain("Schemas");
    expect(html).toContain('aria-label="Close capability details"');
    expect(html.indexOf(">Reset<")).toBeLessThan(html.indexOf('aria-label="Close capability details"'));
    expect(html).not.toContain("Action policy");
    for (const className of legacyDetailClasses) expect(html).not.toContain(className);
  });

  test("keeps action policy context conditional and preserves policy labels", () => {
    const html = renderWorkspace(actionSelection);

    expect(html).toContain('class="k2b-detail-panel__summary"');
    expect(html).toContain("Action policy");
    expect(html).toContain("Destructive");
    expect(html).toContain("Open world");
    expect(html).toContain("Idempotency: required");
    expect(html.match(/<section class="k2b-detail-panel__summary"/g)).toHaveLength(1);
    expect(html.match(/k2b-detail-panel__body/g)).toHaveLength(1);
  });

  test("uses shared nested primitives for resource references and semantic links", () => {
    const html = renderToString(() =>
      createComponent(CapabilityResultView, {
        selection: querySelection,
        data: { count: 1 },
        refs: [{ type: "mail.message", id: "message-1" }],
        page: { hasMore: true, nextCursor: "cursor-2" },
        links: [{ rel: "open", href: "/app/mail/inbox?message=message-1", title: "Open message" }],
      }),
    );

    expect(html).toContain('class="k2b-description-list');
    expect(html).toContain('data-action-visibility="always"');
    expect(html).toContain("mail.message");
    expect(html).toContain("message-1");
    expect(html).toContain('class="k2b-detail-panel__action');
    expect(html).toContain('href="/app/mail/inbox?message=message-1"');
    expect(html).toContain("Open message");
    expect(html).toContain("More results are available");
    for (const className of legacyDetailClasses) expect(html).not.toContain(className);
  });
});
