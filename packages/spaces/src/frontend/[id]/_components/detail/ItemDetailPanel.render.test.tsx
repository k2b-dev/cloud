import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { SpaceComment, SpaceItem } from "@/contracts";

const root = mkdtempSync(join(tmpdir(), "spaces-detail-render-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { default: ItemDetailPanel } = await import("./ItemDetailPanel");
const { LocaleProvider } = await import("@k2b/ui");

const spaceId = "Space1";
const itemId = "Item01";
const userId = "33333333-3333-4333-8333-333333333333";
const now = "2026-08-09T10:00:00.000Z";

const task: SpaceItem = {
  id: itemId,
  spaceId,
  columnId: "Col001",
  title: "Planning review",
  description: null,
  location: null,
  url: null,
  startsAt: null,
  endsAt: null,
  allDay: false,
  deadline: null,
  estimatedDurationMinutes: null,
  activeBlockerCount: 0,
  priority: null,
  recurrence: null,
  recurringEventId: null,
  recurrenceId: null,
  rank: "1024",
  completedAt: null,
  createdBy: userId,
  createdAt: now,
  updatedAt: now,
  assignees: [],
  tags: [],
};

const event: SpaceItem = {
  ...task,
  description: "Bring the **release notes**.",
  location: "Studio",
  url: "https://example.test/meeting",
  startsAt: "2026-08-10T10:00:00.000Z",
  endsAt: "2026-08-10T11:00:00.000Z",
  priority: "high",
  assignees: [{ id: userId, displayName: "Valentin Kolb", avatarHash: null }],
  tags: [{ id: "Tag001", spaceId, name: "Release", color: "#2563eb" }],
};

const comment: SpaceComment = {
  id: "Com001",
  itemId,
  recurrenceId: null,
  userId,
  userName: "Valentin Kolb",
  userAvatarHash: null,
  content: "Ready for review",
  createdAt: now,
  updatedAt: now,
  canEdit: true,
  canDelete: true,
};

const renderPanel = (overrides: Partial<Parameters<typeof ItemDetailPanel>[0]> = {}, locale = "en") =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(ItemDetailPanel, {
          item: event,
          columns: [],
          tags: event.tags ?? [],
          wormholes: [],
          spaceId,
          baseUrl: `/app/spaces/${spaceId}?view=calendar`,
          currentUserId: userId,
          initialCommentsPage: { items: [comment], page: 1, perPage: 50, total: 1, hasNext: true },
          commentTarget: { itemId, recurrenceId: null },
          recurringContext: null,
          dateConfig: { locale: "en", timeZone: "Europe/Berlin" },
          canWrite: true,
          mailIntegrationAvailable: true,
          scrollPreserveKey: `spaces-detail-${spaceId}-${itemId}-series`,
          ...overrides,
        });
      },
    }),
  );

const legacyDetailClasses = ['class="detail-header', 'class="detail-stack', 'class="detail-section', 'class="detail-facts'];

describe("Spaces item detail panel", () => {
  test("composes event context and comments through the shared detail contracts", () => {
    const html = renderPanel();

    expect(html).toContain('class="k2b-detail-panel"');
    expect(html).toContain("<h2>Planning review</h2>");
    expect(html).toContain('data-scroll-preserve="spaces-detail-Space1-Item01-series"');
    expect(html.match(/k2b-detail-panel__body/g)).toHaveLength(1);
    expect(html).toContain('class="k2b-detail-panel__summary"');
    expect(html).toContain("Event time");
    expect(html).toContain('aria-label="Event context"');
    expect(html).toContain('aria-label="Organization"');
    expect(html).toContain("Prepare invitation");
    expect(html).not.toContain("Invite attendees through Mail.");
    expect(html).toContain('class="k2b-detail-panel__action');
    expect(html).toContain('class="k2b-discussion');
    expect(html).toContain('class="k2b-discussion__composer');
    expect(html).toContain('class="k2b-discussion__composer-inset-action"');
    expect(html).toContain('aria-label="Post comment"');
    expect(html).toContain('class="k2b-markdown-editor');
    expect(html).not.toContain('class="k2b-markdown-editor__toolbar"');
    expect(html).toContain('class="k2b-discussion__item');
    expect(html).toContain('data-visibility="progressive"');
    expect(html).not.toContain('data-visibility="always"');
    expect(html).toContain("Load earlier comments");
    expect(html).toContain('aria-label="Edit comment"');
    expect(html).toContain('class="ti ti-pencil"');
    expect(html).toContain('aria-label="Delete comment"');
    expect(html).toContain('aria-label="Close item details"');
    expect(html).toContain('aria-label="More item actions"');
    expect(html).toContain("Mark complete");
    expect(html).toContain("view-transition-name:detail-panel");
    expect(html).toContain("view-transition-name:space-item-detail-header");
    expect(html).toContain("view-transition-name:space-item-detail-description");
    expect(html).toContain('aria-label="Content"');
    expect(html).toContain("view-transition-name: space-item-detail-comments");
    expect(html).toContain("Item information");
    expect(html).toContain('aria-label="Item metadata"');
    expect(html).not.toContain('<details class="k2b-detail-panel__section" open');
    expect(html).not.toContain("overflow-y-auto");
    for (const className of legacyDetailClasses) expect(html).not.toContain(className);
  });

  test("keeps a sparse read-only task free of write controls and empty groups", () => {
    const html = renderPanel({
      item: task,
      tags: [],
      initialCommentsPage: { items: [], page: 1, perPage: 50, total: 0, hasNext: false },
      canWrite: false,
      mailIntegrationAvailable: false,
    });

    expect(html).toContain("Read only");
    expect(html).toContain('style="color:var(--k2b-text-muted)"><i class="ti ti-circle" aria-hidden="true"></i>Active');
    expect(html).not.toContain("bg-[var(--k2b-success-500)]");
    expect(html).toContain('aria-label="Close item details"');
    expect(html).not.toContain('aria-label="More item actions"');
    expect(html).not.toContain("Mark complete");
    expect(html).not.toContain(">Edit<");
    expect(html).not.toContain('class="k2b-detail-panel__summary"');
    expect(html).not.toContain('aria-label="Organization"');
    expect(html).not.toContain('class="k2b-discussion');
    expect(html).not.toContain("Invitations");
    expect(html.match(/k2b-detail-panel__body/g)).toHaveLength(1);
  });

  test("shows task estimates, connections, and related tasks in their detail sections", () => {
    const html = renderPanel({
      item: { ...task, estimatedDurationMinutes: 90 },
      blockedBy: [
        {
          blocker: { id: "Block1", spaceId, title: "Approve scope", completedAt: null },
          createdAt: now,
        },
      ],
      blocks: [
        {
          dependent: { id: "Next01", spaceId, title: "Publish release", completedAt: null },
          createdAt: now,
        },
      ],
      references: [
        {
          ref: { type: "spaces.item", id: "Rel001" },
          label: "Prepare launch notes",
          createdAt: now,
          resource: {
            ref: { type: "spaces.item", id: "Rel001" },
            title: "Prepare launch notes",
            icon: "ti ti-checkbox",
            links: [{ rel: "open", href: `/app/spaces/${spaceId}?item=Rel001` }],
          },
        },
      ],
    });

    expect(html).toContain("1 h 30 min");
    expect(html).toContain('aria-label="Task context"');
    expect(html).toContain("Blocked by");
    expect(html).toContain("Approve scope");
    expect(html).toContain("Active blocker");
    expect(html).toContain("Blocks");
    expect(html).toContain("Publish release");
    expect(html).toContain("Complete all blocking tasks first");
    expect(html).toContain('data-variant="secondary" disabled');
    expect(html).toContain("background:var(--k2b-warning-surface)");
    expect(html).toContain("color:var(--k2b-warning-text)");
    expect(html).toContain('<i class="ti ti-lock" aria-hidden="true"></i>Blocked by 1');
    expect(html).not.toContain("text-[0.6875rem] font-medium leading-4 text-amber-700");
    expect(html).toMatch(/aria-label="Task context"[\s\S]*>Blocked by<\/[h]3>[\s\S]*>Blocks<\/[h]3>[\s\S]*>Linked resources<\/[h]3>/);
    expect(html).toContain("Related tasks");
    expect(html).toContain("Prepare launch notes");
  });

  test("uses wrapped image thumbnails and a detail action picker for task screenshots", () => {
    const html = renderPanel({
      item: task,
      attachments: [
        {
          id: "File01",
          filename: "broken-dialog.webp",
          mimeType: "image/webp",
          sizeBytes: 42_000,
          kind: "image",
          createdAt: now,
        },
      ],
    });

    expect(html).toContain('aria-label="Content"');
    expect(html).toContain(">Attachments</h3>");
    expect(html).toContain("flex flex-wrap gap-2");
    expect(html).toContain('style="width:5rem;height:5rem;min-width:5rem;min-height:5rem;flex:0 0 5rem"');
    expect(html).toContain('aria-label="Preview broken-dialog.webp"');
    expect(html).toContain('aria-label="Delete broken-dialog.webp"');
    expect(html).toContain(">Add image</span>");
    expect(html).not.toContain('class="k2b-image-input"');
    expect(html).not.toContain("Images are optimized");
    expect(html).toContain("/attachments/File01/content");
  });

  test("shows existing task images read-only without picker or delete controls", () => {
    const html = renderPanel({
      item: task,
      canWrite: false,
      attachments: [
        {
          id: "File01",
          filename: "trace.webp",
          mimeType: "image/webp",
          sizeBytes: 512,
          kind: "image",
          createdAt: now,
        },
      ],
    });

    expect(html).toContain('aria-label="Preview trace.webp"');
    expect(html).not.toContain(">Add image</span>");
    expect(html).not.toContain('aria-label="Delete trace.webp"');
  });

  test("omits the reverse Blocks section until the task blocks another task", () => {
    const html = renderPanel({
      item: task,
      blockedBy: [
        {
          blocker: { id: "Block1", spaceId, title: "Approve scope", completedAt: null },
          createdAt: now,
        },
      ],
      blocks: [],
      references: [],
    });

    expect(html).toContain('aria-label="Task context"');
    expect(html).toContain(">Blocked by</h3>");
    expect(html).toContain(">Linked resources</h3>");
    expect(html).not.toContain(">Blocks</h3>");
    expect(html).toContain("Blocked by 1");
  });

  test("uses the comment count as the empty state without duplicate copy", () => {
    const html = renderPanel({ initialCommentsPage: { items: [], page: 1, perPage: 50, total: 0, hasNext: false } });

    expect(html).toContain('class="k2b-discussion__count">0</span>');
    expect(html).not.toContain("No comments yet.");
  });

  test("uses the human-readable recurrence summary in event details", () => {
    const html = renderPanel({
      item: {
        ...event,
        recurrence: {
          rrule: "FREQ=WEEKLY;BYDAY=MO;UNTIL=20260815T235959Z",
          dtstart: event.startsAt,
          exdate: [],
        },
      },
    });

    expect(html).toContain("Repeats every Monday at 12:00 until Sat 15 Aug 2026");
  });

  test("keeps generated occurrences read-only at item level with occurrence-scoped comments", () => {
    const recurrenceId = "2026-08-10T10:00:00.000Z";
    const html = renderPanel({
      commentTarget: { itemId, recurrenceId },
      recurringContext: {
        seriesItemId: itemId,
        recurrenceId,
        startsAt: event.startsAt!,
        endsAt: event.endsAt!,
        allDay: false,
        isOverride: false,
      },
    });

    expect(html).toContain("This occurrence");
    expect(html).toContain("View series");
    expect(html).toContain("Occurrence comments");
    expect(html).toContain('aria-label="Post comment"');
    expect(html).not.toContain('aria-label="More item actions"');
    expect(html).not.toContain("Mark complete");
    expect(html).not.toContain("Prepare invitation");
    expect(html).not.toContain("Link Cloud resource");
  });

  test("localizes occurrence navigation and matches status typography", () => {
    const html = renderPanel(
      {
        recurringContext: {
          seriesItemId: itemId,
          recurrenceId: event.startsAt!,
          startsAt: event.startsAt!,
          endsAt: event.endsAt!,
          allDay: false,
          isOverride: false,
        },
      },
      "de-DE",
    );
    expect(html).toContain("Nur dieser Termin");
    expect(html).toContain("Serie anzeigen");
    expect(html).not.toContain("This occurrence");
    expect(html).not.toContain("View series");
    expect(html).toContain(
      'class="inline-flex items-center gap-1.5 text-[0.6875rem] font-medium leading-4" style="color:var(--k2b-text-muted)"><i class="ti ti-repeat"',
    );
  });

  test("offers the shared Cloud resource picker action before the first link", () => {
    const html = renderPanel({ references: [] });

    expect(html).toContain(">Linked resources</h3>");
    expect(html).toContain('aria-label="Resource context"');
    expect(html).toContain("k2b-detail-panel__action");
    expect(html).toContain("ti ti-link-plus text-[var(--k2b-action)]");
    expect(html).toContain(">Link Cloud resource</span>");
  });

  test("opens accessible linked resources and preserves unavailable reference snapshots", () => {
    const html = renderPanel({
      references: [
        {
          ref: { type: "mail.conversation", id: "Conv01" },
          label: "Release planning",
          createdAt: now,
          resource: {
            ref: { type: "mail.conversation", id: "Conv01" },
            title: "Release planning",
            icon: "ti ti-mail",
            links: [{ rel: "open", href: "/app/mail/Box001?conversation=Conv01" }],
          },
        },
        {
          ref: { type: "mail.conversation", id: "Gone01" },
          label: "Archived discussion",
          createdAt: now,
          resource: null,
        },
      ],
      canWrite: false,
    });

    expect(html).toContain(">Linked resources</h3>");
    expect(html).toContain('class="k2b-detail-panel__group" role="group" aria-label="Resource context"');
    expect(html).toContain('href="/app/mail/Box001?conversation=Conv01"');
    expect(html.match(/ti ti-mail/g)).toHaveLength(2);
    expect(html).toContain("Archived discussion");
    expect(html).toContain("Resource unavailable or no longer accessible");
    expect(html).not.toContain('aria-label="Unlink resource"');
    expect(html).not.toContain("Link Cloud resource");
  });

  test("keeps resource navigation primary and moves unlink into the shared overflow menu", () => {
    const html = renderPanel({
      references: [
        {
          ref: { type: "mail.conversation", id: "Conv01" },
          label: "Release planning",
          createdAt: now,
          resource: {
            ref: { type: "mail.conversation", id: "Conv01" },
            title: "Release planning",
            icon: "ti ti-mail",
            links: [{ rel: "open", href: "/app/mail/Box001?conversation=Conv01" }],
          },
        },
      ],
      canWrite: true,
    });

    expect(html).toContain('class="k2b-detail-panel__action-row"');
    expect(html).toContain('aria-label="More actions for Release planning"');
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain(">Unlink</span>");
    expect(html).not.toContain('aria-label="Unlink resource"');
    expect(html).toContain(">Link Cloud resource</span>");
  });
});
