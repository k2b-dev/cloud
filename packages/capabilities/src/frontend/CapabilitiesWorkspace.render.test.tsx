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
  test("composes a query runner in the K1 outline through one shared detail-panel scroll owner", () => {
    const html = renderWorkspace(querySelection);

    expect(html).toContain('class="k2b-detail-panel"');
    expect(html).toContain('class="k2b-detail-panel__kind"');
    expect(html).toContain("<h2>Search messages</h2>");
    expect(html).toContain("Find messages in a mailbox.");
    expect(html).not.toContain("k2b-detail-panel__header-icon");
    expect(html).toContain('data-scroll-preserve="capability-mail-query-messages.search"');
    expect(html.match(/k2b-detail-panel__body/g)).toHaveLength(1);
    // Header: the one main command and the rarer commands behind "…" below the identity row.
    expect(html).toContain('class="k2b-button capabilities-run');
    expect(html).toContain(">Run<");
    expect(html).toContain('aria-label="More actions"');
    expect(html.slice(html.indexOf('class="k2b-detail-panel__primary-actions"'))).toContain('aria-label="More actions"');
    // Fixed order: properties, then request and response, then "More about this query".
    const properties = html.indexOf(">Properties<");
    const request = html.indexOf(">Request<");
    const response = html.indexOf(">Response<");
    const more = html.indexOf("More about this query");
    expect(properties).toBeGreaterThan(-1);
    expect(properties).toBeLessThan(request);
    expect(request).toBeLessThan(response);
    expect(response).toBeLessThan(more);
    expect(html).toContain("mail.messages.search");
    expect(html).toContain('role="group" aria-label="Capability run"');
    expect(html).toContain("Ready to run");
    expect(html.slice(more)).toContain("Request as cURL");
    expect(html.slice(more)).toContain("POST /api/capabilities/");
    expect(html.slice(more)).toContain("Schemas");
    expect(html.slice(more)).toContain("Input schema · Data schema");
    expect(html).toContain('aria-label="Close capability details"');
    // No section icons in the outline.
    expect(html).not.toContain("k2b-detail-panel__section-icon");
    expect(html).not.toContain("Action policy");
    for (const className of legacyDetailClasses) expect(html).not.toContain(className);
  });

  test("shows action policy as property rows and the destructive state in the kind line", () => {
    const html = renderWorkspace(actionSelection);

    expect(html).not.toContain('class="k2b-detail-panel__summary"');
    const kind = html.slice(html.indexOf('class="k2b-detail-panel__kind"'), html.indexOf("<h2>"));
    expect(kind).toContain("Action");
    expect(kind).toContain("Destructive");
    expect(html).toContain(">Effect<");
    expect(html).toContain(">Reach<");
    expect(html).toContain("Open world");
    expect(html).toContain(">Idempotency<");
    expect(html).toContain(">required<");
    expect(html).toContain("More about this action");
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
