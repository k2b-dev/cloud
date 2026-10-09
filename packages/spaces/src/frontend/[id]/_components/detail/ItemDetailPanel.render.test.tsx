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
    expect(html).toContain(">Planning</h3>");
    // Events read top to bottom: planning, the event itself, content, people, links, comments, and collapsed details.
    expect(html).toMatch(
      /k2b-detail-panel__summary[\s\S]*aria-label="Event"[\s\S]*aria-label="Content"[\s\S]*aria-label="People"[\s\S]*aria-label="Context"[\s\S]*>Links &amp; resources<\/h3>[\s\S]*k2b-discussion[\s\S]*aria-label="Item metadata"[\s\S]*>Details<\/span>/,
    );
    // Priority and tags stay editable in the planning block; the people list has no claim holder.
    expect(html).toMatch(
      /k2b-detail-panel__summary[\s\S]*>Duration<[\s\S]*aria-label="Priority"[\s\S]*aria-label="Tags"[\s\S]*aria-label="Event"/,
    );
    expect(html).not.toContain(">Priority</label>");
    expect(html).not.toContain("data-spaces-claim-holder");
    expect(html).not.toContain('aria-label="Work"');
    expect(html).not.toContain(">Blocked by</h3>");
    expect(html).toContain('aria-label="Edit planning"');
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
    expect(html).toContain("view-transition-name:detail-panel");
    expect(html).toContain("view-transition-name:space-item-detail-header");
    expect(html).toContain("view-transition-name:space-item-detail-description");
    expect(html).toContain('aria-label="Content"');
    expect(html).toContain("view-transition-name: space-item-detail-comments");
    expect(html).toContain(">Details</span>");
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
    // Only the collapsed details remain; empty groups without edit rights stay hidden.
    expect(html.match(/role="group"/g)).toHaveLength(1);
    expect(html).toContain('role="group" aria-label="Item metadata"');
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
    // Editors always get the people list to assign someone, but nobody leads it without a claim.
    expect(unclaimed).toContain('aria-label="Work"');
    expect(unclaimed).toContain(">Assigned</h3>");
    expect(unclaimed).not.toContain("data-spaces-claim-holder");

    const own = renderPanel({ item: { ...task, claim: { ...claim, actor: { kind: "user", id: userId }, displayName: "Valentin Kolb" } } });
    expect(own).toContain('data-spaces-claim-action="release"');
    expect(own.match(/data-spaces-claim-action/g)).toHaveLength(1);
    expect(own).toContain('aria-label="Work"');
    expect(own).toContain('data-own-claim="true"');
    expect(own).not.toContain('data-spaces-claim-action="claim"');
    // An own claim reads like any holder row with the person's name; "You're on it" stays the avatar's name.
    expect(own).toContain('<span class="truncate text-sm">Valentin Kolb</span>');
    expect(own).toContain(`title="You're on it"`);

    // The holder leads the people list in the assignee row layout: extra-small avatar with the outer success ring, the
    // name with a "working on it" label that says what the ring shows, and a secondary line with the claim time that
    // wraps instead of hiding the "not assigned" marker.
    const foreign = renderPanel({ item: { ...task, claim } });
    expect(foreign).toContain('title="Mira Beck is on it"');
    expect(foreign).toContain(
      '<span class="k2b-avatar spaces-claim-ring" data-size="xs" data-tint="6" style="" role="img" aria-label="Mira Beck is on it">MB</span></span><div class="min-w-0 flex-1"><span class="flex min-w-0 items-center gap-1.5"><span class="truncate text-sm">Mira Beck</span><span class="k2b-status-badge shrink-0" data-tone="ok" data-variant="chip"><span class="k2b-status-badge__label">working on it</span></span></span><span class="block text-xs text-dimmed">since <time class="whitespace-nowrap" datetime="' +
        now +
        '">',
    );
    expect(foreign).toMatch(/ (<!--!\$-->)?<span class="whitespace-nowrap">· not assigned<\/span>/);
    expect(foreign).not.toContain("data-spaces-claim-action");
    expect(foreign).not.toContain("Task claimed");

    // No help sentence in the section; the take-over explanation lives in its confirmation dialog.
    const admin = renderPanel({ item: { ...task, claim }, isAdmin: true });
    expect(admin).toContain('data-spaces-claim-action="take-over"');
    expect(admin).not.toContain("Take over releases the claim");
    expect(admin.match(/data-spaces-claim-action/g)).toHaveLength(1);
    for (const html of [own, foreign, admin]) {
      expect(html).not.toContain("Release the claim when you stop");
      expect(html).not.toContain("once the claim is released");
    }

    const german = renderPanel({ item: { ...task, claim }, isAdmin: true }, "de");
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
    expect(html).toContain('aria-label="Context"');
    expect(html).toContain("Approve scope");
    expect(html).toContain("Publish release");
    expect(html).toContain("Complete all blocking tasks first");
    expect(html).toContain('data-variant="secondary" disabled');
    expect(html).toContain("background:var(--k2b-warning-surface)");
    expect(html).toContain("color:var(--k2b-warning-text)");
    expect(html).toContain('<i class="ti ti-lock" aria-hidden="true"></i>Blocked by 1');
    expect(html).not.toContain("text-[0.6875rem] font-medium leading-4 text-amber-700");
    // Blockers and dependents are planning facts; related tasks and links read as one context below.
    expect(html).toMatch(
      /k2b-detail-panel__summary[\s\S]*>Blocked by<\/dt>[\s\S]*Approve scope[\s\S]*>Blocks<\/dt>[\s\S]*Publish release[\s\S]*aria-label="Context"[\s\S]*>Related tasks<\/[h]3>[\s\S]*Prepare launch notes[\s\S]*>Links &amp; resources<\/[h]3>/,
    );
    expect(html).not.toContain(">Blocked by</h3>");
    expect(html).not.toContain(">Blocks</h3>");
    // Tasks read top to bottom: planning, content, work, context, comments, and collapsed details.
    expect(html).toMatch(
      /k2b-detail-panel__summary[\s\S]*aria-label="Content"[\s\S]*aria-label="Work"[\s\S]*aria-label="Context"[\s\S]*k2b-discussion[\s\S]*aria-label="Item metadata"/,
    );
    expect(html.match(/>Related tasks<\/h3>/g)).toHaveLength(1);
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
    expect(html).toContain('aria-label="Play reel.mp4"');
    // The island replaces this HTML when it mounts, so the server tile names no video: it would start a load that is
    // cut off and repeated. The browser's tile loads the first frame.
    expect(html).toMatch(/aria-label="Play reel\.mp4"[^>]*><video (?![^>]*\ssrc=)[^>]*preload="metadata"/);
    expect(html).not.toContain("/attachments/Reel01/content");
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
    expect(html).toContain(">Links &amp; resources</h3>");
    expect(html).not.toContain(">Blocks</dt>");
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

  test("labels the header edit action in the reader's language", () => {
    const header = (locale: string) => {
      const html = renderPanel({ item: task }, locale);
      return html.slice(0, html.indexOf("</header>"));
    };
    expect(header("en")).toContain("Edit</span></button>");
    expect(header("de")).toContain("Bearbeiten</span></button>");
    expect(header("de")).not.toContain("Edit</span>");
  });

  test("offers the add-link and Cloud resource picker actions before the first link", () => {
    const html = renderPanel({ references: [] });

    expect(html).toContain(">Links &amp; resources</h3>");
    expect(html).toContain('aria-label="Context"');
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

    expect(html).toContain(">Links &amp; resources</h3>");
    expect(html).toContain('class="k2b-detail-panel__group" role="group" aria-label="Context"');
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
    '<aside class="k2b-notice-card" data-tone="warning" role="note"><p class="k2b-notice-card__title">Before the release</p><div class="k2b-notice-card__body"><p>Check the <strong>migration</strong>.</p>',
  );
  expect(html).toContain('<aside class="k2b-notice-card" data-tone="success" role="note"><span class="k2b-sr-only">Erfolg: </span>');
  expect(html).toContain('<aside class="k2b-notice-card" data-tone="info" role="note"><span class="k2b-sr-only">Info: </span>');
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
  expect(html).toContain('aria-label="Arbeit"');
  expect(html).toContain(">Zuständig</h3>");
  expect(html).toContain('aria-label="Du arbeitest daran"');
  expect(html).toContain("seit <time");
  expect(html).toMatch(/ (<!--!\$-->)?<span class="whitespace-nowrap">· nicht zugewiesen<\/span>/);
  expect(html).not.toContain("data-spaces-claim-action");
  expect(html).toContain(">Letzter Stand</h3>");
  expect(html).toContain("Nächster Schritt");
  expect(html).toContain(">Letztes Ergebnis</h3>");
  expect(html).toContain("Tests erfolgreich");
  expect(html).toContain("a1b2c3d");
});

describe("Spaces item detail groups", () => {
  const holderId = "44444444-4444-4444-8444-444444444444";
  const mira = { id: holderId, displayName: "Mira Beck", avatarHash: null };
  const valentin = { id: userId, displayName: "Valentin Kolb", avatarHash: null };
  const miraClaim = {
    id: "55555555-5555-4555-8555-555555555555",
    actor: { kind: "user" as const, id: holderId },
    displayName: "Mira Beck",
    avatarHash: null,
    claimedAt: now,
  };
  /** The people list of the Work group, from its Assigned section up to the add-assignee picker. */
  const peopleList = (html: string) => {
    const start = html.indexOf(">Assigned</h3>");
    return html.slice(start, html.indexOf('aria-label="Add assignee"', start));
  };

  test("shows an assigned claim holder once, first, with the claim time and the assignee's remove action", () => {
    const html = renderPanel({ item: { ...task, assignees: [valentin, mira], claim: miraClaim } });
    const people = peopleList(html);

    expect(people.match(/>Mira Beck<\/span>/g)).toHaveLength(1);
    expect(people.indexOf("data-spaces-claim-holder")).toBeLessThan(people.indexOf(">Valentin Kolb</span>"));
    expect(people).toContain(`since <time class="whitespace-nowrap" datetime="${now}">`);
    expect(people).not.toContain("not assigned");
    expect(people).toContain('aria-label="Remove Mira Beck"');
    expect(people).toContain('aria-label="Remove Valentin Kolb"');
    // The claim is only shown in the people list; there is no separate claim section anymore.
    expect(html.match(/data-spaces-claim-badge/g)).toHaveLength(1);
  });

  test("leads with a service account holder that is not assigned and keeps it out of the assignee actions", () => {
    const html = renderPanel({
      item: {
        ...task,
        assignees: [valentin],
        claim: { ...miraClaim, actor: { kind: "service_account", id: holderId }, displayName: "Release agent" },
      },
    });
    const people = peopleList(html);

    expect(people.indexOf("data-spaces-claim-holder")).toBeLessThan(people.indexOf(">Valentin Kolb</span>"));
    expect(people).toContain('class="ti ti-api"');
    expect(people).toContain(">Release agent</span>");
    expect(people).toMatch(/ (<!--!\$-->)?<span class="whitespace-nowrap">· not assigned<\/span>/);
    expect(people).not.toContain('aria-label="Remove Release agent"');
    expect(people).toContain('aria-label="Remove Valentin Kolb"');
  });

  test("keeps the holder visible to readers and hides the assignee controls", () => {
    const html = renderPanel({ item: { ...task, claim: miraClaim }, canWrite: false });

    expect(html).toContain('aria-label="Work"');
    expect(html).toContain("data-spaces-claim-holder");
    expect(html).not.toContain('aria-label="Add assignee"');
    expect(html).not.toContain('aria-label="Remove Mira Beck"');
  });

  test("lists blocking tasks in the planning block, open ones first, and folds long lists", () => {
    const entry = (id: string, title: string, completedAt: string | null = null) => ({
      blocker: { id, spaceId, title, completedAt },
      createdAt: now,
    });
    const planning = (html: string) => html.slice(html.indexOf('class="k2b-detail-panel__summary"'), html.indexOf('aria-label="Content"'));
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
    expect(german).toContain(">Aufgabe<");
    expect(german).toContain("erledigt");

    // Readers see the blockers without remove or add controls; without blockers the row is gone.
    const reader = renderPanel({ item: task, blockedBy: [entry("Block1", "Approve scope")], canWrite: false });
    expect(reader).toContain(">Planning</h3>");
    expect(titles(reader, "blocker")).toEqual(["Approve scope"]);
    expect(reader).not.toContain("Remove blocker");
    expect(reader).not.toContain('aria-label="Add task blocker"');
    expect(reader).not.toContain('aria-label="Priority"');
    expect(renderPanel({ item: task, canWrite: false })).not.toContain(">Blocked by</dt>");
  });

  test("collects due date, estimate, priority, and tags in one planning block", () => {
    const planned: SpaceItem = {
      ...task,
      deadline: "2026-08-12T10:00:00.000Z",
      estimatedDurationMinutes: 45,
      priority: "high",
      tags: [{ id: "Tag001", spaceId, name: "Release", color: "#2563eb" }],
    };
    const planning = (html: string) =>
      html.slice(html.indexOf('class="k2b-detail-panel__summary"'), html.indexOf("</dl></div></section>") + "</dl>".length);

    const editor = renderPanel({ item: planned });
    const summary = planning(editor);
    expect(summary).toMatch(/>Due<\/dt>[\s\S]*>Estimate<\/dt>[\s\S]*>Priority<\/dt>[\s\S]*>Tags<\/dt>[\s\S]*>Blocked by<\/dt>/);
    // Every property is a plain control: the value reads as text and the whole row opens its picker.
    expect(summary.match(/data-appearance="plain"/g)).toHaveLength(5);
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
    expect(summary).toContain('aria-label="Edit planning"');
    expect(editor).not.toContain(">Deadline</dt>");

    // Empty properties stay as rows for editors and say what is missing.
    const empty = planning(renderPanel({ item: task }));
    expect(empty).toMatch(
      />Due<\/dt>[\s\S]*>No deadline<[\s\S]*>Estimate<\/dt>[\s\S]*placeholder="No estimate"[\s\S]*>Priority<\/dt>[\s\S]*data-empty="true"[\s\S]*>No priority<[\s\S]*>Tags<\/dt>[\s\S]*ti ti-plus k2b-choice-trigger__placeholder-icon[\s\S]*>Tag</,
    );
    const germanEmpty = planning(renderPanel({ item: task }, "de"));
    expect(germanEmpty).toContain(">Kein Fälligkeitsdatum<");
    expect(germanEmpty).toContain('placeholder="Keine Schätzung"');
    expect(germanEmpty).toContain(">Keine Priorität<");

    // Readers see the values without controls; empty rows are omitted instead of saying "No priority".
    const reader = planning(renderPanel({ item: planned, canWrite: false }));
    expect(reader).toMatch(
      />Due<\/dt>[\s\S]*Aug 12, 2026, 12:00[\s\S]*>Estimate<\/dt><dd>45 min<[\s\S]*>Priority<\/dt>[\s\S]*spaces-priority-value__dot[\s\S]*High[\s\S]*>Tags<\/dt>[\s\S]*>Release<\/span>/,
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
    expect(sparseReader).not.toContain('aria-label="Edit planning"');
  });

  test("keeps the checklist with the content and hides empty sections from readers", () => {
    const editor = renderPanel({
      item: task,
      checklist: [
        { id: "Chk001", label: "Write tests", completed: true, createdAt: now, updatedAt: now },
        { id: "Chk002", label: "Ship", completed: false, createdAt: now, updatedAt: now },
      ],
    });
    expect(editor).toMatch(/aria-label="Content"[\s\S]*>Checklist<\/h3>[\s\S]*>1\/2<[\s\S]*>Attachments<\/h3>[\s\S]*aria-label="Work"/);
    expect(editor).not.toContain('aria-label="Progress"');

    const reader = renderPanel({ item: { ...task, description: "Only the **brief**." }, canWrite: false });
    expect(reader).toContain('aria-label="Content"');
    expect(reader).toContain(">Description</h3>");
    expect(reader).not.toContain(">Checklist</h3>");
    expect(reader).not.toContain(">Attachments</h3>");

    const linksOnly = renderPanel({
      item: task,
      canWrite: false,
      links: [{ url: "https://example.org/spec", label: "Spec", createdAt: now, preview: null }],
    });
    expect(linksOnly).toContain('aria-label="Context"');
    expect(linksOnly).toContain(">Links &amp; resources</h3>");
    expect(linksOnly).not.toContain(">Blocked by</h3>");
    expect(linksOnly).not.toContain('aria-label="Work"');
  });

  test("names the groups in German", () => {
    const html = renderPanel(
      {
        item: { ...task, deadline: "2026-08-12T10:00:00.000Z", claim: miraClaim },
        blockedBy: [{ blocker: { id: "Block1", spaceId, title: "Approve scope", completedAt: null }, createdAt: now }],
      },
      "de",
    );
    expect(html).toContain(">Planung</h3>");
    expect(html).toContain(">Fällig</dt>");
    expect(html).toContain('aria-label="Inhalt"');
    expect(html).toContain('aria-label="Arbeit"');
    expect(html).toContain(">Zuständig</h3>");
    expect(html).toContain('aria-label="Zusammenhang"');
    expect(html).toContain(">Links &amp; Ressourcen</h3>");
    expect(html).toContain('aria-label="Eintragsmetadaten"');
    expect(html).toContain('aria-label="Planung bearbeiten"');
    expect(html).not.toContain("Einordnung");
    expect(html).not.toContain("Fortschritt");
  });
});
