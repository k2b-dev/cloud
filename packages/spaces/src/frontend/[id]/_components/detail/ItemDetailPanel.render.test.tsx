import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { SpaceComment, SpaceItem, SpaceItemReaction } from "@/contracts";

const root = mkdtempSync(join(tmpdir(), "spaces-detail-render-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { default: ItemDetailPanel } = await import("./ItemDetailPanel");
const { LocaleProvider, renderMarkdownInfoBlock } = await import("@k2b/ui");

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
  deadlineAllDay: false,
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
  assignees: [{ id: userId, kind: "user" as const, displayName: "Valentin Kolb", avatarHash: null }],
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

afterEach(() => setSystemTime());

const legacyDetailClasses = ['class="detail-header', 'class="detail-stack', 'class="detail-section', 'class="detail-facts'];

describe("Spaces item detail panel", () => {
  test("composes event context and comments through the shared detail contracts", () => {
    const html = renderPanel();

    expect(html).toContain('class="k2b-detail-panel"');
    expect(html).toContain("<h2>Planning review</h2>");
    expect(html).toContain('data-scroll-preserve="spaces-detail-Space1-Item01-series"');
    expect(html.match(/k2b-detail-panel__body/g)).toHaveLength(1);
    // The K1 outline: the kind and state above the title, then properties, the event's own content, linked items,
    // comments, and "More about this event" with collapsed sections.
    expect(html).toContain('class="k2b-detail-panel__kind"><span>Event</span>');
    expect(html).not.toContain("ti-calendar-event");
    expect(html).not.toContain('class="k2b-detail-panel__summary"');
    expect(html).toMatch(
      />Properties<\/h3>[\s\S]*>Description<\/h3>[\s\S]*>Invitations<\/h3>[\s\S]*>Linked<\/h3>[\s\S]*k2b-discussion[\s\S]*>More about this event<\/div>[\s\S]*>Technical details<\/span>/,
    );
    // Schedule, place, and people first; priority and tags stay editable as property rows.
    expect(html).toMatch(
      />Start<\/dt>[\s\S]*>Duration<\/dt>[\s\S]*>Location<\/dt>[\s\S]*>URL<\/dt>[\s\S]*>Assigned<\/dt>[\s\S]*aria-label="Tags"[\s\S]*aria-label="Priority"[\s\S]*>Description<\/h3>/,
    );
    // Sections in the outline carry no icons; their titles start on the text edge.
    expect(html).not.toContain("k2b-detail-panel__section-icon");
    expect(html).not.toContain("k2b-discussion__icon");
    expect(html).not.toContain(">Priority</label>");
    expect(html).not.toContain("data-spaces-claim-holder");
    expect(html).not.toContain(">Blocked by</dt>");
    expect(html).toContain('aria-label="Edit item"');
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
    // The assignee row and the comment author show the same person with the shared avatar initials.
    expect(html.match(/aria-label="Valentin Kolb avatar">VK</g)).toHaveLength(2);
    expect(html).toContain('aria-label="Delete comment"');
    expect(html).toContain('aria-label="Close item details"');
    expect(html).toContain('aria-label="More item actions"');
    expect(html).toContain("Mark complete");
    expect(html).toContain('class="k2b-button spaces-details-done');
    expect(html).toContain("view-transition-name:detail-panel");
    expect(html).toContain("view-transition-name:space-item-detail-header");
    expect(html).toContain("view-transition-name:space-item-detail-description");
    expect(html).toContain("view-transition-name: space-item-detail-comments");
    // Comments read oldest to newest with the composer below them.
    expect(html).toMatch(/k2b-discussion__item[\s\S]*k2b-discussion__composer/);
    expect(html).toContain(">ID, created, updated</span>");
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

    expect(html).toContain('<span class="k2b-status-badge__label">Read only</span>');
    expect(html).toContain(
      'data-tone="neutral" data-variant="chip"><i class="ti ti-circle" aria-hidden="true"></i><span class="k2b-status-badge__label">Active</span>',
    );
    expect(html).toContain("<p>Created Aug 9, 2026</p>");
    expect(html).toContain('aria-label="Close item details"');
    expect(html).not.toContain('aria-label="More item actions"');
    expect(html).not.toContain("Mark complete");
    expect(html).not.toContain('aria-label="Edit item"');
    expect(html).not.toContain("k2b-detail-panel__primary-actions");
    // Only "More about this task" remains; empty sections without edit rights stay hidden.
    expect(html).not.toContain(">Properties</h3>");
    expect(html.match(/role="group"/g)).toHaveLength(1);
    expect(html).toContain(">More about this task</div>");
    expect(html).not.toContain('class="k2b-discussion');
    expect(html).not.toContain("Invitations");
    expect(html.match(/k2b-detail-panel__body/g)).toHaveLength(1);
  });

  test("lets people claim, release, or take over a task from the detail panel", () => {
    const otherUserId = "44444444-4444-4444-8444-444444444444";
    const claim = {
      id: "55555555-5555-4555-8555-555555555555",
      actor: { kind: "user" as const, id: otherUserId },
      displayName: "Mira Beck",
      avatarHash: null,
      claimedAt: now,
    };

    const unclaimed = renderPanel({ item: { ...task, claim: null } });
    expect(unclaimed).toContain('data-spaces-claim-action="claim"');
    expect(unclaimed).toContain("I'm on it");
    // Editors always get the Assigned row to assign someone, but nobody leads it without a claim.
    expect(unclaimed).toContain(">Assigned</dt>");
    expect(unclaimed).not.toContain("data-spaces-claim-holder");
    // The claim control sits in the header beside the main action.
    const header = unclaimed.slice(0, unclaimed.indexOf("</header>"));
    expect(header).toMatch(/spaces-details-done[\s\S]*data-spaces-claim-action="claim"[\s\S]*aria-label="More item actions"/);

    const own = renderPanel({ item: { ...task, claim: { ...claim, actor: { kind: "user", id: userId }, displayName: "Valentin Kolb" } } });
    expect(own).toContain('data-spaces-claim-action="release"');
    expect(own.match(/data-spaces-claim-action/g)).toHaveLength(1);
    expect(own).toContain('data-own-claim="true"');
    expect(own).not.toContain('data-spaces-claim-action="claim"');
    // An own claim reads like any holder row with the person's name; "You're on it" stays the avatar's name.
    expect(own).toContain('title="Valentin Kolb">Valentin Kolb</span>');
    expect(own).toContain(`title="You're on it"`);

    // Working is a state in the same single-line people row, with its time and an accessible ring label.
    const foreign = renderPanel({ item: { ...task, claim } });
    expect(foreign).toContain('title="Mira Beck is on it"');
    expect(foreign).toContain('data-ring="success"');
    expect(foreign).toContain('<span class="k2b-status-badge__label">working on it</span>');
    expect(foreign).toContain(`since <time datetime="${now}" title="`);
    expect(foreign).not.toContain("not assigned");
    expect(foreign).not.toContain("nicht zugewiesen");
    expect(foreign).not.toContain("Task claimed");
    // Claims coordinate work and do not lock it: anyone who may change the task may take one over, nobody else.
    expect(renderPanel({ item: { ...task, claim }, canWrite: false })).not.toContain("data-spaces-claim-action");

    // No help sentence in the panel; the take-over explanation lives in its confirmation dialog.
    expect(foreign).toContain('data-spaces-claim-action="take-over"');
    expect(foreign.slice(0, foreign.indexOf("</header>"))).toContain('data-spaces-claim-action="take-over"');
    expect(foreign).not.toContain("Take over releases the claim");
    expect(foreign.match(/data-spaces-claim-action/g)).toHaveLength(1);
    for (const html of [own, foreign]) {
      expect(html).not.toContain("Release the claim when you stop");
      expect(html).not.toContain("once the claim is released");
    }

    const german = renderPanel({ item: { ...task, claim } }, "de");
    expect(german).toContain("Mira Beck arbeitet daran");
    expect(german).toContain('<span class="k2b-status-badge__label">arbeitet daran</span>');
    expect(german).toContain(">Übernehmen<");

    expect(renderPanel({ item: { ...task, claim: null }, canWrite: false })).not.toContain("data-spaces-claim-action");
    expect(renderPanel({ item: { ...task, claim: null, completedAt: now } })).not.toContain("data-spaces-claim-action");
    expect(renderPanel({ item: event })).not.toContain("data-spaces-claim-action");
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

    // Editors edit the estimate in place; readers read it formatted.
    expect(html).toContain('aria-label="Estimate"');
    expect(html).toContain('value="90"');
    expect(renderPanel({ item: { ...task, estimatedDurationMinutes: 90 }, canWrite: false })).toContain("1 h 30 min");
    expect(html).toContain("Approve scope");
    expect(html).toContain("Publish release");
    expect(html).toContain("Complete all blocking tasks first");
    expect(html).toContain(
      'data-blocked="" type="button" class="k2b-button spaces-details-done " data-size="sm" data-variant="subtle" disabled',
    );
    expect(html).toContain('<i class="ti ti-lock" aria-hidden="true"></i>Mark complete</span>');
    expect(html).toContain(
      'data-tone="warning" data-variant="chip"><i class="ti ti-lock" aria-hidden="true"></i><span class="k2b-status-badge__label">Blocked by 1</span>',
    );
    // Blockers and dependents are property rows; related tasks lead the one Linked section below.
    expect(html).toMatch(
      />Properties<\/h3>[\s\S]*>Blocked by<\/dt>[\s\S]*Approve scope[\s\S]*>Blocks<\/dt>[\s\S]*Publish release[\s\S]*>Linked<\/h3>[\s\S]*Prepare launch notes/,
    );
    expect(html).not.toContain(">Blocked by</h3>");
    expect(html).not.toContain(">Blocks</h3>");
    // Tasks read top to bottom: properties, checklist, linked, attachments, comments, and "More about this task".
    expect(html).toMatch(
      />Properties<\/h3>[\s\S]*>Checklist<\/h3>[\s\S]*>Linked<\/h3>[\s\S]*>Attachments<\/h3>[\s\S]*k2b-discussion[\s\S]*>More about this task<\/div>/,
    );
    expect(html.match(/>Linked<\/h3>/g)).toHaveLength(1);
  });

  test("lists task screenshots as a file list with their kind, size, and row actions", () => {
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

    expect(html).toContain(">Attachments</h3>");
    // One list row per file: the whole row opens it, the actions wait in their reserved slot.
    expect(html).toContain(
      'data-layout="list" data-action-visibility="progressive" data-open-items="true" role="list" aria-label="Attachments"',
    );
    expect(html).toMatch(/class="k2b-file-grid__name"[^>]*>broken-dialog\.webp</);
    expect(html).toMatch(/class="k2b-file-grid__meta"[^>]*>Image · 41/);
    expect(html).not.toContain("image/webp ·");
    expect(html).toContain('aria-label="Download broken-dialog.webp"');
    expect(html).toContain('aria-label="Delete broken-dialog.webp"');
    expect(html).toContain(">Add image or video</span>");
    expect(html).not.toContain('class="k2b-image-input"');
    expect(html).not.toContain("Images are optimized");
    expect(html).toContain("/attachments/File01/content");
  });

  test("shows a read-only task's video with a playable tile", () => {
    const html = renderPanel({
      item: task,
      canWrite: false,
      attachments: [
        {
          id: "Reel01",
          filename: "reel.mp4",
          mimeType: "video/mp4",
          sizeBytes: 4_000_000,
          kind: "file",
          createdAt: now,
        },
      ],
    });

    expect(html).toContain(">Attachments</h3>");
    expect(html).toMatch(/class="k2b-file-grid__name"[^>]*>reel\.mp4</);
    // The island replaces this HTML when it mounts, so the server preview names no video: it would start a load that
    // is cut off and repeated. The browser's preview loads the first frame.
    expect(html).toMatch(/class="spaces-attachment-video"><video(?![^>]*\ssrc=)[^>]*preload="metadata"/);
    expect(html).not.toContain("/attachments/Reel01/content#t=");
    expect(html).not.toContain('aria-label="Delete reel.mp4"');
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

    expect(html).toMatch(/class="k2b-file-grid__name"[^>]*>trace\.webp</);
    expect(html).toContain('aria-label="Download trace.webp"');
    expect(html).not.toContain(">Add image or video</span>");
    expect(html).not.toContain('aria-label="Delete trace.webp"');
  });

  test("omits the reverse Blocks row until the task blocks another task", () => {
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

    expect(html).toContain(">Blocked by</dt>");
    expect(html).toContain(">Linked</h3>");
    expect(html).not.toContain(">Blocks</dt>");
    expect(html).toContain("Blocked by 1");
  });

  test("uses the comment count as the empty state without duplicate copy", () => {
    const html = renderPanel({ initialCommentsPage: { items: [], page: 1, perPage: 50, total: 0, hasNext: false } });

    expect(html).toContain('class="k2b-detail-panel__none">None yet</span>');
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

    expect(html).toContain("Repeats every Monday at 12:00 until Sat, Aug 15, 2026");
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

  test("localizes occurrence navigation and shows it as a state beside the kind", () => {
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
    expect(html).toMatch(
      /class="k2b-detail-panel__kind"><span>Termin<\/span>[\s\S]*?<i class="ti ti-repeat" aria-hidden="true"><\/i><span class="k2b-status-badge__label">Nur dieser Termin<\/span>/,
    );
  });

  test("moves editing into the header menu and the properties' pencil, in the reader's language", () => {
    const header = (locale: string) => {
      const html = renderPanel({ item: task }, locale);
      return html.slice(0, html.indexOf("</header>"));
    };
    // The one main action stands alone with "…"; Edit is the menu's first entry.
    expect(header("en")).not.toContain("Edit</span></button>");
    expect(header("en")).toMatch(/role="menu" aria-label="More item actions"[\s\S]*?<span>Edit item<\/span>/);
    expect(header("de")).toMatch(/<span>Eintrag bearbeiten<\/span>/);
    expect(header("de")).not.toContain("Edit item");
    expect(renderPanel({ item: task }, "de")).toContain('aria-label="Eintrag bearbeiten"');
  });

  test("offers the add-link and Cloud resource picker actions before the first link", () => {
    const html = renderPanel({ references: [] });

    expect(html).toContain(">Linked</h3>");
    expect(html).toContain("k2b-detail-panel__action");
    expect(html).toContain("ti ti-link-plus text-[var(--k2b-action)]");
    expect(html).toContain(">Add link</span>");
    expect(html).toContain(">Link Cloud resource</span>");
  });

  test("renders external links with their GitHub state or their host", () => {
    const html = renderPanel({
      references: [],
      links: [
        {
          url: "https://github.com/k2b-dev/cloud/issues/263",
          label: null,
          createdAt: now,
          preview: { kind: "github", repo: "k2b-dev/cloud", number: 263, type: "issue", title: "Links on items", state: "open" },
        },
        { url: "https://github.com/k2b-dev/cloud/pull/1", label: null, createdAt: now, preview: null },
        { url: "https://example.org/spec", label: "Spec", createdAt: now, preview: null },
      ],
    });

    expect(html).toContain('href="https://github.com/k2b-dev/cloud/issues/263"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain(">Links on items</span>");
    expect(html).toContain("k2b-dev/cloud#263");
    expect(html).toContain(">Open<");
    // A GitHub link without a preview still reads as repo#number.
    expect(html).toContain(">k2b-dev/cloud#1</span>");
    expect(html).toContain('src="https://example.org/favicon.ico"');
    expect(html).toContain(">Spec</span>");
    expect(html).toContain(">example.org</span>");
    expect(html).toContain(">Remove link<");
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

    expect(html).toContain(">Linked</h3>");
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

test("renders info blocks in descriptions, comments, and progress notes like every Markdown view", () => {
  const html = renderPanel(
    {
      item: { ...task, description: ":::warning Before the release\nCheck the **migration**.\n:::" },
      initialCommentsPage: {
        items: [{ ...comment, content: ":::success\nApproved.\n:::" }],
        page: 1,
        perPage: 50,
        total: 1,
        hasNext: false,
      },
      work: {
        claim: null,
        progress: { content: ":::info\nTests are running.\n:::", actor: { kind: "user", id: userId }, at: now },
        result: null,
      },
    },
    "de",
  );
  expect(html).toContain(
    renderMarkdownInfoBlock({
      type: "warning",
      title: "Before the release",
      bodyHtml: "<p>Check the <strong>migration</strong>.</p>\n",
      locale: "de",
    }),
  );
  expect(html).toContain(renderMarkdownInfoBlock({ type: "success", bodyHtml: "<p>Approved.</p>\n", locale: "de" }));
  expect(html).toContain(renderMarkdownInfoBlock({ type: "info", bodyHtml: "<p>Tests are running.</p>\n", locale: "de" }));
  expect(html).not.toContain(":::");
});

test("renders work progress and preserved completion evidence in German", () => {
  const html = renderPanel(
    {
      item: {
        ...task,
        claim: {
          id: "11111111-1111-4111-8111-111111111111",
          actor: { kind: "user", id: userId },
          displayName: "Valentin Kolb",
          avatarHash: null,
          claimedAt: now,
        },
      },
      canWrite: false,
      work: {
        claim: { id: "11111111-1111-4111-8111-111111111111", actor: { kind: "user", id: userId }, claimedAt: now },
        progress: { content: "Nächster Schritt: Dokumentation prüfen.", actor: { kind: "user", id: userId }, at: now },
        result: { content: "Verifikation: Tests erfolgreich.", commit: "a1b2c3d", actor: { kind: "user", id: userId }, at: now },
      },
    },
    "de",
  );
  expect(html).toContain(">Zugewiesen</dt>");
  expect(html).toContain('aria-label="Du arbeitest daran"');
  expect(html).toContain("seit <time");
  expect(html).toContain(`datetime="${now}"`);
  expect(html).not.toContain("nicht zugewiesen");
  expect(html).not.toContain("data-spaces-claim-action");
  expect(html).toContain(">Letzter Stand</h3>");
  expect(html).toContain("Nächster Schritt");
  expect(html).toContain(">Letztes Ergebnis</h3>");
  expect(html).toContain("Tests erfolgreich");
  expect(html).toContain("a1b2c3d");
});

describe("Spaces item detail groups", () => {
  const holderId = "44444444-4444-4444-8444-444444444444";
  const mira = { id: holderId, kind: "user" as const, displayName: "Mira Beck", avatarHash: null };
  const valentin = { id: userId, kind: "user" as const, displayName: "Valentin Kolb", avatarHash: null };
  const miraClaim = {
    id: "55555555-5555-4555-8555-555555555555",
    actor: { kind: "user" as const, id: holderId },
    displayName: "Mira Beck",
    avatarHash: null,
    claimedAt: now,
  };
  /** The people list of the Assigned property row, from its term up to the add-assignee picker. */
  const peopleList = (html: string, locale: string) => {
    const start = html.indexOf(locale === "de" ? ">Zugewiesen</dt>" : ">Assigned</dt>");
    const end = html.indexOf(locale === "de" ? 'aria-label="Zuständige Person hinzufügen"' : 'aria-label="Add assignee"', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return html.slice(start, end);
  };
  const rows = (people: string) => people.split(/<div[^>]*data-spaces-assignee-row[^>]*>/).slice(1);
  const workingRow = (row: string, locale: string) => {
    expect(row).toContain('data-ring="success"');
    expect(row).toContain(`<span class="k2b-status-badge__label">${locale === "de" ? "arbeitet daran" : "working on it"}</span>`);
    expect(row).toContain(`${locale === "de" ? "seit" : "since"} <time datetime="${now}" title="`);
  };

  for (const locale of ["en", "de"]) {
    test(`${locale}: shows an assigned worker once, first, with relative time and the assignee's remove action`, () => {
      setSystemTime(new Date("2026-08-09T12:00:00.000Z"));
      const html = renderPanel({ item: { ...task, assignees: [valentin, mira], claim: miraClaim } }, locale);
      const people = peopleList(html, locale);
      const list = rows(people);
      expect(list).toHaveLength(2);
      expect(people.match(/>Mira Beck<\/span>/g)).toHaveLength(1);
      expect(list[0]).toContain(">Mira Beck</span>");
      expect(people).toMatch(/data-spaces-assignee-row data-spaces-claim-holder=""/);
      workingRow(list[0]!, locale);
      expect(list[0]).toContain(">12:00</time>");
      expect(list[0]).toContain(locale === "de" ? 'aria-label="Mira Beck entfernen"' : 'aria-label="Remove Mira Beck"');
      expect(list[1]).toContain(locale === "de" ? 'aria-label="Valentin Kolb entfernen"' : 'aria-label="Remove Valentin Kolb"');
      expect(list[1]).not.toContain('data-ring="success"');
      expect(people).not.toContain("not assigned");
      expect(people).not.toContain("nicht zugewiesen");
      expect(html.match(/data-spaces-claim-badge/g)).toHaveLength(1);
    });

    for (const serviceAccountKind of [undefined, "standalone", "agent"] as const) {
      const kind = serviceAccountKind ? "service_account" : "user";
      test(`${locale}: keeps a ${serviceAccountKind ?? kind} holder outside the assignees first, without a remove action`, () => {
        const people = peopleList(
          renderPanel(
            {
              item: {
                ...task,
                assignees: [valentin],
                claim: { ...miraClaim, actor: { kind, id: holderId }, displayName: "Release agent", serviceAccountKind },
              },
            },
            locale,
          ),
          locale,
        );
        const list = rows(people);
        expect(list).toHaveLength(2);
        expect(list[0]).toContain(">Release agent</span>");
        workingRow(list[0]!, locale);
        expect(list[0]).not.toContain("<button");
        if (serviceAccountKind) expect(list[0]).toContain(`class="ti ti-${serviceAccountKind === "agent" ? "robot" : "key"}"`);
        expect(list[1]).toContain(">Valentin Kolb</span>");
        expect(people).not.toContain("not assigned");
        expect(people).not.toContain("nicht zugewiesen");
      });
    }

    test(`${locale}: does not merge a service account into a person with the same id`, () => {
      const people = peopleList(
        renderPanel(
          {
            item: {
              ...task,
              assignees: [mira],
              claim: { ...miraClaim, actor: { kind: "service_account", id: mira.id }, displayName: "Task worker" },
            },
          },
          locale,
        ),
        locale,
      );
      const list = rows(people);
      expect(list).toHaveLength(2);
      workingRow(list[0]!, locale);
      expect(list[0]).toContain(">Task worker</span>");
      expect(list[0]).not.toContain("<button");
      expect(list[1]).toContain(">Mira Beck</span>");
      expect(list[1]).not.toContain('data-ring="success"');
      expect(list[1]).not.toContain("k2b-status-badge");
    });
  }

  test("keeps the holder visible to readers and hides the assignee controls", () => {
    const html = renderPanel({ item: { ...task, claim: miraClaim }, canWrite: false });

    expect(html).toContain(">Assigned</dt>");
    expect(html).toContain("data-spaces-claim-holder");
    expect(html).not.toContain('aria-label="Add assignee"');
    expect(html).not.toContain('aria-label="Remove Mira Beck"');
  });

  test("lists blocking tasks in the properties, open ones first, and folds long lists", () => {
    const entry = (id: string, title: string, completedAt: string | null = null) => ({
      blocker: { id, spaceId, title, completedAt },
      createdAt: now,
    });
    const planning = (html: string) => html.slice(html.indexOf(">Properties</h3>"), html.indexOf(">Checklist</h3>"));
    const titles = (html: string, kind: "blocker" | "dependent") => {
      const list = html.slice(
        html.indexOf(`data-spaces-dependencies="${kind}"`),
        html.indexOf("</ul>", html.indexOf(`data-spaces-dependencies="${kind}"`)),
      );
      return [...list.matchAll(/<a [^>]*><i [^>]*><\/i><span class="spaces-dependency__title">([^<]+)</g)].map((match) => match[1]);
    };

    const blocked = renderPanel({
      item: task,
      blockedBy: [entry("Block1", "Order cables", now), entry("Block2", "Approve scope"), entry("Block3", "Book the hall")],
    });
    const rows = planning(blocked);
    // Done blockers follow the open ones and say so; the lock marks an open blocker for sighted readers and words for the rest.
    expect(titles(rows, "blocker")).toEqual(["Approve scope", "Book the hall", "Order cables"]);
    expect(rows).toContain('href="/app/spaces/Space1?view=calendar&amp;item=Block2"');
    expect(rows).toMatch(/data-state="open"><a [^>]*><i class="ti ti-lock spaces-dependency__icon"/);
    expect(rows).toContain('<span class="sr-only">, open</span>');
    expect(rows).toMatch(
      /data-state="done"><a [^>]*><i class="ti ti-circle-check spaces-dependency__icon"[\s\S]*?class="spaces-dependency__state">[\s\S]*?done</,
    );
    // Editors remove a blocker from its row and add one with the task search below the list.
    expect(rows).toContain('aria-label="Remove blocker Approve scope"');
    expect(rows).toContain('aria-label="Add task blocker"');
    expect(rows).toMatch(/aria-label="Add task blocker"[\s\S]*?k2b-choice-trigger__placeholder-icon[\s\S]*?>Task</);
    // No jump link and no second copy of the list further down.
    expect(blocked).not.toContain("ti-arrow-down");
    expect(blocked).not.toContain(">Blocked by</h3>");
    expect(blocked).toContain("Blocked by 2");

    // The add action is there before the first blocker, so a task can always get one.
    const free = planning(renderPanel({ item: task }));
    expect(free).toContain(">Blocked by</dt>");
    expect(titles(free, "blocker")).toEqual([]);
    expect(free).toContain('aria-label="Add task blocker"');

    // From five entries on, three stay visible and the rest fold behind "N more".
    const many = renderPanel({
      item: task,
      blockedBy: ["A", "B", "C", "D", "E"].map((letter, index) => entry(`Blk00${index}`, `Step ${letter}`, index === 0 ? now : null)),
      blocks: ["F", "G", "H", "I"].map((letter, index) => ({
        dependent: { id: `Dep00${index}`, spaceId, title: `Follow-up ${letter}`, completedAt: null },
        createdAt: now,
      })),
    });
    expect(titles(many, "blocker")).toEqual(["Step B", "Step C", "Step D"]);
    expect(many).toMatch(/aria-expanded="false"[^>]*>[\s\S]*?>2 more</);
    // Four entries stay unfolded; tasks waiting on this one show an empty circle and no remove button.
    expect(titles(many, "dependent")).toEqual(["Follow-up F", "Follow-up G", "Follow-up H", "Follow-up I"]);
    expect(many).toMatch(/data-state="waiting"><a [^>]*><i class="ti ti-circle spaces-dependency__icon"/);
    expect(many).not.toContain('aria-label="Remove blocker Follow-up F"');

    const german = renderPanel({ item: task, blockedBy: [entry("Block1", "Approve scope", now)] }, "de");
    expect(german).toContain(">Blockiert durch</dt>");
    expect(german).toContain(">Eigenschaften</h3>");
    expect(german).toContain(">Aufgabe<");
    expect(german).toContain("erledigt");

    // Readers see the blockers without remove or add controls; without blockers the row is gone.
    const reader = renderPanel({ item: task, blockedBy: [entry("Block1", "Approve scope")], canWrite: false });
    expect(reader).toContain(">Properties</h3>");
    expect(titles(reader, "blocker")).toEqual(["Approve scope"]);
    expect(reader).not.toContain("Remove blocker");
    expect(reader).not.toContain('aria-label="Add task blocker"');
    expect(reader).not.toContain('aria-label="Priority"');
    expect(renderPanel({ item: task, canWrite: false })).not.toContain(">Blocked by</dt>");
  });

  test("collects assignees, due date, tags, priority, and estimate as property rows", () => {
    const planned: SpaceItem = {
      ...task,
      deadline: "2026-08-12T10:00:00.000Z",
      estimatedDurationMinutes: 45,
      priority: "high",
      tags: [{ id: "Tag001", spaceId, name: "Release", color: "#2563eb" }],
    };
    const planning = (html: string) =>
      html.slice(html.search(/>(Properties|Eigenschaften)<\/h3>/), html.indexOf("</dl></div></section>") + "</dl>".length);

    const editor = renderPanel({ item: planned });
    const summary = planning(editor);
    expect(summary).toMatch(
      />Assigned<\/dt>[\s\S]*>Due<\/dt>[\s\S]*>Tags<\/dt>[\s\S]*>Priority<\/dt>[\s\S]*>Estimate<\/dt>[\s\S]*>Blocked by<\/dt>/,
    );
    // Every property is a plain control, the add-assignee picker included: the value reads as text and the whole row
    // opens its picker. No property is a form field.
    expect(summary.match(/data-appearance="plain"/g)).toHaveLength(6);
    expect(summary).toMatch(/aria-label="Add assignee"[\s\S]*?k2b-choice-trigger__placeholder-icon[\s\S]*?>Person</);
    expect(summary).not.toContain('data-appearance="field"');
    expect(summary).toContain("Aug 12, 2026, 12:00");
    expect(summary).toContain('<span class="text-dimmed"> · ');
    expect(summary).toContain('value="45"');
    // At rest the estimate reads as a duration, as readers see it; the minutes suffix shows while editing.
    expect(summary).toContain('data-value="45 min"');
    expect(summary).toContain('aria-valuetext="45 min"');
    expect(summary).not.toContain(">min</span>");
    expect(summary).toContain(">High</span>");
    expect(summary).toContain(">Release</span>");
    // The description list term names each control; the options popovers carry the same name.
    expect(summary).toContain('aria-label="Due"');
    expect(summary).toContain('aria-label="Estimate"');
    expect(summary).toContain('class="k2b-choice-popover" role="group" aria-label="Priority"');
    expect(summary).toContain('class="k2b-choice-popover" role="group" aria-label="Tags"');
    expect(summary).not.toContain('aria-label="Options"');
    expect(summary).toContain('aria-label="Edit item"');
    expect(editor).not.toContain(">Deadline</dt>");

    // Empty properties stay as rows for editors and say what is missing.
    const empty = planning(renderPanel({ item: task }));
    expect(empty).toMatch(
      />Due<\/dt>[\s\S]*>No deadline<[\s\S]*>Tags<\/dt>[\s\S]*ti ti-plus k2b-choice-trigger__placeholder-icon[\s\S]*>Tag<[\s\S]*>Priority<\/dt>[\s\S]*data-empty="true"[\s\S]*>No priority<[\s\S]*>Estimate<\/dt>[\s\S]*placeholder="No estimate"/,
    );
    const germanEmpty = planning(renderPanel({ item: task }, "de"));
    expect(germanEmpty).toContain(">Kein Fälligkeitsdatum<");
    expect(germanEmpty).toContain('placeholder="Keine Schätzung"');
    expect(germanEmpty).toContain(">Keine Priorität<");

    // Readers see the values without controls; empty rows are omitted instead of saying "No priority".
    const reader = planning(renderPanel({ item: planned, canWrite: false }));
    expect(reader).toMatch(
      />Due<\/dt>[\s\S]*Aug 12, 2026, 12:00[\s\S]*>Tags<\/dt>[\s\S]*>Release<\/span>[\s\S]*>Priority<\/dt>[\s\S]*spaces-priority-value__dot[\s\S]*High[\s\S]*>Estimate<\/dt><dd>45 min</,
    );
    expect(reader).not.toContain("data-appearance");
    const sparseReader = planning(
      renderPanel({ item: { ...planned, deadline: null, estimatedDurationMinutes: null, priority: null }, canWrite: false }),
    );
    expect(sparseReader).toContain(">Tags</dt>");
    expect(sparseReader).not.toContain(">Due</dt>");
    expect(sparseReader).not.toContain(">Priority</dt>");
    expect(sparseReader).not.toContain("No priority");
    expect(sparseReader).not.toContain('role="combobox"');
    expect(sparseReader).not.toContain('aria-label="Edit item"');
  });

  test("keeps the checklist below the properties and hides empty sections from readers", () => {
    const editor = renderPanel({
      item: task,
      checklist: [
        { id: "Chk001", label: "Write tests", completed: true, createdAt: now, updatedAt: now },
        { id: "Chk002", label: "Ship", completed: false, createdAt: now, updatedAt: now },
      ],
    });
    expect(editor).toMatch(/>Properties<\/h3>[\s\S]*>Checklist<\/h3>[\s\S]*>1\/2<[\s\S]*>Linked<\/h3>[\s\S]*>Attachments<\/h3>/);
    expect(editor).not.toContain('aria-label="Progress"');

    const reader = renderPanel({ item: { ...task, description: "Only the **brief**." }, canWrite: false });
    expect(reader).toContain(">Description</h3>");
    expect(reader).not.toContain(">Checklist</h3>");
    expect(reader).not.toContain(">Attachments</h3>");

    const linksOnly = renderPanel({
      item: task,
      canWrite: false,
      links: [{ url: "https://example.org/spec", label: "Spec", createdAt: now, preview: null }],
    });
    expect(linksOnly).toContain(">Linked</h3>");
    expect(linksOnly).not.toContain(">Blocked by</dt>");
    expect(linksOnly).not.toContain(">Assigned</dt>");
  });

  test("names the outline in German as the approved mockup does", () => {
    const html = renderPanel(
      {
        item: { ...task, deadline: "2026-08-12T10:00:00.000Z", claim: miraClaim },
        blockedBy: [{ blocker: { id: "Block1", spaceId, title: "Approve scope", completedAt: null }, createdAt: now }],
      },
      "de",
    );
    expect(html).toContain('class="k2b-detail-panel__kind"><span>Aufgabe</span>');
    expect(html).toContain(">Eigenschaften</h3>");
    expect(html).toMatch(/>Zugewiesen<\/dt>[\s\S]*>Fällig<\/dt>[\s\S]*>Tags<\/dt>[\s\S]*>Priorität<\/dt>/);
    expect(html).toContain(">Verknüpft</h3>");
    expect(html).toContain(">Anhänge</h3>");
    expect(html).toContain(">Kommentare</h3>");
    expect(html).toContain(">Mehr zu dieser Aufgabe</div>");
    expect(html).toContain(">Technische Details</span>");
    expect(html).toContain(">ID, erstellt, aktualisiert</span>");
    expect(html).toContain("<p>Erstellt am Aug 9, 2026</p>");
    expect(renderPanel({ item: task }, "de")).toContain("Als erledigt markieren");
    expect(html).not.toContain("Einordnung");
    expect(html).not.toContain("Fortschritt");
    expect(renderPanel({}, "de")).toContain(">Mehr zu diesem Termin</div>");
  });
});

describe("Spaces detail reactions", () => {
  beforeEach(() => setSystemTime(new Date(now)));
  const reactions: SpaceItemReaction[] = ["👍", "❤️", "🎉", "👀", "🚀"].map((emoji, index) => ({
    emoji,
    count: index === 0 ? 2 : 1,
    own: index === 0,
    people: [{ kind: "user", id: "other", displayName: "Nora Brandt" }],
  }));
  // Restrict assertions to the row: the rest of the detail has its own controls.
  const row = (html: string) => {
    const start = html.indexOf('class="k2b-reaction-bar spaces-item-reactions"');
    return start < 0 ? "" : html.slice(start, html.indexOf('class="k2b-tooltip k2b-reaction-bar__hint', start));
  };

  test("writers see all reactions after the preceding groups and before comments", () => {
    const html = renderPanel({ item: { ...task, description: "Current instructions", reactions } });
    expect(html).toMatch(
      />Properties<\/h3>[\s\S]*>Description<\/h3>[\s\S]*>Linked<\/h3>[\s\S]*>Attachments<\/h3>[\s\S]*spaces-item-reactions[\s\S]*k2b-discussion[\s\S]*>More about this task<\/div>/,
    );
    const bar = row(html);
    expect(bar).toContain('data-density="default"');
    expect(bar).toContain('data-add="always"');
    expect(bar.match(/<button[^>]*class="k2b-reaction-bar__chip"/g)).toHaveLength(reactions.length);
    expect(bar.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(bar.match(/aria-pressed="false"/g)).toHaveLength(reactions.length - 1);
    for (const { emoji } of reactions) expect(bar).toContain(`data-reaction-key="${emoji}"`);
    expect(bar).not.toContain("k2b-reaction-bar__more");
    expect(bar).toContain('aria-label="Add reaction"');
  });

  test("a writer without reactions sees only Add reaction", () => {
    const bar = row(renderPanel({ item: { ...task, reactions: [] } }));
    expect(bar).not.toBe("");
    expect(bar).toContain('aria-label="Add reaction"');
    expect(bar.match(/<button\b/g)).toHaveLength(1);
    expect(bar).not.toContain("k2b-reaction-bar__chip");
  });

  test("a reader without reactions has no row", () => {
    expect(renderPanel({ item: { ...task, reactions: [] }, canWrite: false })).not.toContain("spaces-item-reactions");
  });

  test("a reader sees all reactions as images without Add reaction", () => {
    const bar = row(renderPanel({ item: { ...task, reactions }, canWrite: false }));
    expect(bar.match(/class="k2b-reaction-bar__chip" role="img" aria-label=/g)).toHaveLength(reactions.length);
    expect(bar).not.toContain("<button");
    expect(bar).not.toContain("aria-pressed");
    expect(bar).not.toContain('aria-label="Add reaction"');
    expect(bar).not.toContain("k2b-reaction-bar__more");
  });

  test("generated occurrences have no controls even for writers; overrides have reactions", () => {
    const recurringContext = {
      seriesItemId: itemId,
      recurrenceId: "2026-08-10T10:00:00.000Z",
      startsAt: "2026-08-10T10:00:00.000Z",
      endsAt: "2026-08-10T11:00:00.000Z",
      allDay: false,
      isOverride: false,
    };
    const generated = renderPanel({ item: { ...task, reactions }, recurringContext, canWrite: true });
    expect(generated).not.toContain("spaces-item-reactions");
    expect(generated).not.toContain("k2b-reaction-bar__chip");
    expect(generated).not.toContain('aria-label="Add reaction"');
    const override = row(
      renderPanel({ item: { ...task, reactions }, recurringContext: { ...recurringContext, isOverride: true }, canWrite: true }),
    );
    expect(override).toContain('aria-pressed="true"');
    expect(override).toContain('aria-label="Add reaction"');
  });
});
