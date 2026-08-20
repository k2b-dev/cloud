import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { compileCapabilityManifest } from "@valentinkolb/cloud/capabilities/testing";
import {
  CAPABILITY_MAX_RESULT_BYTES,
  type CapabilityActionDefinition,
  type CapabilityActionReviewResult,
  CapabilityActionReviewSchema,
  type CapabilityExecutionContext,
  capabilityResultSchema,
  type User,
} from "@valentinkolb/cloud/contracts";
import { audit } from "@valentinkolb/cloud/services";
import { decodeSpacesCapabilityCursor, spacesCapabilities } from "./capabilities";
import {
  CommentCreateInputSchema,
  CommentListDataSchema,
  EventCreateInputSchema,
  EventListDataSchema,
  EventUpdateInputSchema,
  ItemDataSchema,
  SpaceDetailDataSchema,
  SpaceListInputSchema,
  TaskCreateInputSchema,
  TaskListDataSchema,
  TaskListInputSchema,
  TaskUpdateInputSchema,
} from "./capability-contracts";
import type { SpaceComment, SpaceItem, SpaceTag } from "./contracts";
import { spacesService } from "./service";
import { type ResourceTable, spacesPublicResources } from "./service/public-resources";

const userId = "11111111-1111-4111-8111-111111111111";
const serviceAccountId = "22222222-2222-4222-8222-222222222222";
const spaceUuid = "33333333-3333-4333-8333-333333333333";
const otherSpaceUuid = "44444444-4444-4444-8444-444444444444";
const columnUuid = "55555555-5555-4555-8555-555555555555";
const itemUuid = "66666666-6666-4666-8666-666666666666";
const commentUuid = "77777777-7777-4777-8777-777777777777";
const tagUuid = "88888888-8888-4888-8888-888888888888";
const spaceId = "Spc001";
const otherSpaceId = "Spc002";
const columnId = "Col001";
const itemId = "Itm001";
const commentId = "Com001";
const tagId = "Tag001";
const attachmentId = "Att001";
const createdAt = "2026-08-02T08:00:00.000Z";

test("declares remembered approval for bounded Space changes", () => {
  const rememberable = (Object.entries(spacesCapabilities.actions) as Array<[string, CapabilityActionDefinition]>)
    .filter(([, action]) => action.approval === "rememberable")
    .map(([localId]) => localId)
    .sort();
  expect(rememberable).toEqual([
    "calendar-invitation.response.commit",
    "comment.create",
    "comment.update",
    "event.invitation.commit",
    "event.update",
    "item.reference.add",
    "item.reference.remove",
    "item.tags.set",
    "task.blocker.add",
    "task.blocker.remove",
    "task.set-completed",
    "task.update",
  ]);
});

const user = {
  id: userId,
  uid: "spaces-user",
  roles: ["user"],
  provider: "local",
  profile: "user",
  givenname: "Spaces",
  sn: "User",
  displayName: "Spaces User",
  mail: "spaces@example.test",
  avatarHash: null,
  ipa: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
} satisfies User;

const userContext = {
  actor: { kind: "user", user },
  accessSubject: { type: "user", userId },
  user,
  signal: new AbortController().signal,
} satisfies CapabilityExecutionContext;

const serviceAccountContext = {
  actor: {
    kind: "service_account",
    serviceAccount: {
      id: serviceAccountId,
      name: "Spaces resource account",
      kind: "resource_bound",
      status: "active",
      delegatedUserId: null,
      appId: "spaces",
      resourceType: "space",
      resourceId: spaceUuid,
      createdBy: null,
      createdAt,
    },
    delegatedUser: null,
    scopes: ["read"],
  },
  accessSubject: { type: "service_account", serviceAccountId },
  user: null,
  signal: new AbortController().signal,
} satisfies CapabilityExecutionContext;

const space = {
  id: spaceUuid,
  name: "Product",
  description: "Product planning",
  color: "#3b82f6",
  icalToken: "private-token",
  createdAt,
  updatedAt: createdAt,
};

const task: SpaceItem = {
  id: itemUuid,
  spaceId: spaceUuid,
  columnId: columnUuid,
  title: "Ship capability",
  description: null,
  location: null,
  url: null,
  startsAt: null,
  endsAt: null,
  allDay: false,
  deadline: null,
  estimatedDurationMinutes: null,
  activeBlockerCount: 0,
  priority: "high",
  recurrence: null,
  recurringEventId: null,
  recurrenceId: null,
  rank: "1024",
  completedAt: null,
  createdBy: userId,
  createdAt,
  updatedAt: createdAt,
  assignees: [],
  tags: [],
};

const event: SpaceItem = {
  ...task,
  title: "Capability review",
  startsAt: "2026-08-02T10:00:00.000Z",
  endsAt: "2026-08-02T11:00:00.000Z",
  deadline: null,
};

const comment: SpaceComment = {
  id: commentUuid,
  itemId: itemUuid,
  recurrenceId: null,
  userId,
  userName: user.displayName,
  userAvatarHash: "presentation-only",
  content: "Ready for review",
  createdAt,
  updatedAt: createdAt,
  canEdit: true,
  canDelete: true,
};

const tag: SpaceTag = { id: tagUuid, spaceId: spaceUuid, name: "Launch", color: "#22c55e" };

afterEach(() => mock.restore());

const publicIds: Record<ResourceTable, Map<string, string>> = {
  spaces: new Map([
    [spaceUuid, spaceId],
    [otherSpaceUuid, otherSpaceId],
  ]),
  columns: new Map([[columnUuid, columnId]]),
  items: new Map([[itemUuid, itemId]]),
  comments: new Map([[commentUuid, commentId]]),
  tags: new Map([[tagUuid, tagId]]),
  wormholes: new Map(),
};

beforeEach(() => {
  const requiredPublicId = (table: ResourceTable, internalId: string): string => {
    const value = publicIds[table].get(internalId);
    if (!value) throw new Error(`Missing ${table} public ID for ${internalId}`);
    return value;
  };
  spyOn(spacesPublicResources, "resolvePublicId").mockImplementation(async (table, value) => {
    for (const [internal, short] of publicIds[table]) if (short === value) return internal;
    return null;
  });
  spyOn(spacesPublicResources, "resolvePublicIds").mockImplementation(async (table, values) => {
    const resolved = values.map((value) => [...publicIds[table]].find(([, short]) => short === value)?.[0]);
    return resolved.every(Boolean) ? (resolved as string[]) : null;
  });
  spyOn(spacesPublicResources, "resolveSpacePublicIds").mockImplementation(async (table, internalSpaceId, values) => {
    if (internalSpaceId !== spaceUuid) return null;
    const resolved = values.map((value) => [...publicIds[table]].find(([, short]) => short === value)?.[0]);
    return resolved.every(Boolean) ? (resolved as string[]) : null;
  });
  spyOn(spacesPublicResources, "projectSpaces").mockImplementation(async (items) =>
    items.map((item) => ({ ...item, id: requiredPublicId("spaces", item.id) })),
  );
  spyOn(spacesPublicResources, "projectColumns").mockImplementation(async (items) =>
    items.map((item) => ({
      ...item,
      id: requiredPublicId("columns", item.id),
      spaceId: requiredPublicId("spaces", item.spaceId),
    })),
  );
  spyOn(spacesPublicResources, "projectTags").mockImplementation(async (items) =>
    items.map((item) => ({
      ...item,
      id: requiredPublicId("tags", item.id),
      spaceId: requiredPublicId("spaces", item.spaceId),
    })),
  );
  spyOn(spacesPublicResources, "projectItems").mockImplementation(async (items) =>
    items.map((item) => ({
      ...item,
      id: requiredPublicId("items", item.id),
      spaceId: requiredPublicId("spaces", item.spaceId),
      columnId: requiredPublicId("columns", item.columnId),
      tags: item.tags?.map((itemTag) => ({
        ...itemTag,
        id: requiredPublicId("tags", itemTag.id),
        spaceId: requiredPublicId("spaces", itemTag.spaceId),
      })),
    })),
  );
  spyOn(spacesPublicResources, "projectComments").mockImplementation(async (items) =>
    items.map((item) => ({
      ...item,
      id: requiredPublicId("comments", item.id),
      itemId: requiredPublicId("items", item.itemId),
    })),
  );
});

describe("spaces capabilities", () => {
  test("compiles calendar integration inputs into the registered manifest", () => {
    const manifest = compileCapabilityManifest("spaces", spacesCapabilities);
    expect(manifest.queries.some((query) => query.localId === "calendar-invitation.preview")).toBeTrue();
    expect(manifest.actions.some((action) => action.localId === "calendar-invitation.import")).toBeTrue();
    expect(manifest.actions.some((action) => action.localId === "event.invitation.prepare")).toBeTrue();
  });

  test("lists only writable calendar destinations without accepting Mail ownership state", async () => {
    const list = spyOn(spacesService.space, "list").mockResolvedValue({
      items: [space],
      page: 1,
      perPage: 100,
      total: 1,
      hasNext: false,
    });

    const result = await spacesCapabilities.queries["calendar-destination.list"].run({}, userContext);

    expect(list).toHaveBeenCalledWith({
      subject: userContext.accessSubject,
      boundSpaceId: null,
      requiredLevel: "write",
      pagination: { page: 1, perPage: 100 },
    });
    expect(result).toEqual({
      ok: true,
      data: {
        data: [
          {
            id: spaceId,
            name: space.name,
            color: space.color,
            links: [{ rel: "open", href: `/app/spaces/${spaceId}` }],
          },
        ],
      },
    });
  });

  test("declares the complete bounded v1 surface and safety metadata", () => {
    expect(Object.keys(spacesCapabilities.types).sort()).toEqual(["comment", "item", "space"]);
    expect(Object.keys(spacesCapabilities.queries).sort()).toEqual([
      "calendar-destination.list",
      "calendar-invitation.preview",
      "calendar-invitation.response.prepare",
      "comment.list",
      "comment.read",
      "event.list",
      "item.link-candidate.search",
      "item.read",
      "item.reference.find",
      "item.reference.list",
      "item.search",
      "space.assignee.list",
      "space.list",
      "space.read",
      "space.search",
      "task.blocker.list",
      "task.blocks.list",
      "task.list",
    ]);
    expect(Object.keys(spacesCapabilities.actions).sort()).toEqual([
      "calendar-invitation.import",
      "calendar-invitation.response.commit",
      "comment.create",
      "comment.delete",
      "comment.update",
      "event.create",
      "event.invitation.commit",
      "event.invitation.prepare",
      "event.update",
      "item.delete",
      "item.reference.add",
      "item.reference.remove",
      "item.tags.set",
      "task.blocker.add",
      "task.blocker.remove",
      "task.create",
      "task.set-completed",
      "task.update",
    ]);
    expect(
      Object.entries(spacesCapabilities.actions)
        .filter(([, action]) => "review" in action && action.review)
        .map(([id]) => id)
        .sort(),
    ).toEqual([
      "calendar-invitation.import",
      "calendar-invitation.response.commit",
      "comment.create",
      "comment.delete",
      "comment.update",
      "event.invitation.commit",
      "event.update",
      "item.delete",
      "item.reference.add",
      "item.reference.remove",
      "item.tags.set",
      "task.blocker.add",
      "task.blocker.remove",
      "task.set-completed",
      "task.update",
    ]);
    expect(spacesCapabilities.actions["task.create"]).toMatchObject({
      destructive: false,
      openWorld: false,
      idempotency: "none",
    });
    expect(spacesCapabilities.actions["comment.delete"]).toMatchObject({
      destructive: true,
      openWorld: false,
      idempotency: "none",
    });
  });

  test("exposes bounded assignable members through the existing write boundary", async () => {
    spyOn(spacesService.space, "get").mockResolvedValue(space);
    spyOn(spacesService.space.permission, "get").mockResolvedValue("write");
    const listAssignable = spyOn(spacesService.item, "listAssignableUsers").mockResolvedValue([
      { id: userId, displayName: user.displayName, avatarHash: null, description: "spaces-user · direct access" },
    ]);

    const result = await spacesCapabilities.queries["space.assignee.list"].run({ spaceId, query: "Spaces", limit: 5 }, userContext);

    expect(listAssignable).toHaveBeenCalledWith({ spaceId: spaceUuid, search: "Spaces", limit: 5 });
    expect(result).toEqual({
      ok: true,
      data: { data: [{ id: userId, displayName: user.displayName, description: "spaces-user · direct access" }] },
    });
  });

  test("uses agent-oriented calendar creation wording", () => {
    expect(spacesCapabilities.actions["event.create"].title).toBe("Create calendar event");
    expect(spacesCapabilities.actions["event.create"].description).toContain("calendar event");
    expect(spacesCapabilities.actions["calendar-invitation.import"].title).toBe("Import calendar invitation");
  });

  test("keeps Space and item search as focused Universal Search providers", async () => {
    const listSpaces = spyOn(spacesService.space, "listWithPermission").mockResolvedValue({
      items: [{ ...space, permission: "read" }],
      page: 1,
      perPage: 5,
      total: 1,
      hasNext: false,
    });
    const searchItems = spyOn(spacesService.item, "searchAcross").mockResolvedValue([{ item: task, space }]);

    const spaceResult = await spacesCapabilities.queries["space.search"].run({ query: "Product", tags: [], limit: 5 }, userContext);
    expect(spaceResult).toMatchObject({
      ok: true,
      data: { data: [{ ref: { type: "spaces.space", id: spaceId }, title: space.name }] },
    });
    expect(listSpaces).toHaveBeenCalledWith({
      subject: userContext.accessSubject,
      boundSpaceId: null,
      query: "Product",
      pagination: { page: 1, perPage: 5 },
    });
    expect(searchItems).not.toHaveBeenCalled();

    const itemResult = await spacesCapabilities.queries["item.search"].run({ query: "Ship", tags: ["todo"], limit: 5 }, userContext);
    expect(itemResult).toMatchObject({
      ok: true,
      data: { data: [{ ref: { type: "spaces.item", id: itemId }, title: task.title }] },
    });
    expect(searchItems).toHaveBeenCalledWith({
      subject: userContext.accessSubject,
      boundSpaceId: null,
      query: "Ship",
      kinds: "task",
      status: "open",
      priority: undefined,
      requiredLevel: "read",
      limit: 5,
    });
    expect(listSpaces).toHaveBeenCalledTimes(1);
  });

  test("prepares a draft invitation only after current event write access is rechecked", async () => {
    spyOn(spacesService.item, "get").mockResolvedValue(event);
    spyOn(spacesService.space, "get").mockResolvedValue(space);
    spyOn(spacesService.space.permission, "get").mockResolvedValue("write");
    const prepare = spyOn(spacesService.calendarInvitations, "prepareEventInvitationAttachment").mockResolvedValue({
      ok: true,
      data: {
        deliveryId: "88888888-8888-4888-8888-888888888888",
        itemId,
        mailboxId: "mail01",
        draftId: "draft1",
        sequence: 0,
        filename: "invitation.ics",
        contentType: "text/calendar; method=REQUEST; charset=utf-8",
        calendar: "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n",
      },
    });
    spyOn(audit, "recordResultAfterSideEffect").mockImplementation(async ({ result }) => result);
    const context = { ...userContext, idempotencyKey: "mail-calendar-test" } satisfies CapabilityExecutionContext;

    const result = await spacesCapabilities.actions["event.invitation.prepare"].run(
      {
        itemId,
        mailboxId: "mail01",
        draftId: "draft1",
        senderIdentityId: "ident1",
        organizer: { name: "Organizer", address: "organizer@example.test" },
        attendees: [{ name: null, address: "attendee@example.test" }],
      },
      context,
    );

    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        spaceId: spaceUuid,
        itemId: itemUuid,
        subject: userContext.accessSubject,
        deliveryId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      }),
    );
    expect(result).toMatchObject({
      ok: true,
      data: {
        summary: `Prepared an invitation for “${event.title}”.`,
        refs: [
          { type: "spaces.item", id: itemId },
          { type: "mail.draft", id: "draft1" },
        ],
      },
    });
  });

  test("does not treat caller-provided Mail identifiers as Space authorization", async () => {
    spyOn(spacesService.item, "get").mockResolvedValue(event);
    spyOn(spacesService.space, "get").mockResolvedValue(space);
    spyOn(spacesService.space.permission, "get").mockResolvedValue("none");
    spyOn(audit, "recordResult").mockImplementation(async ({ result }) => result);
    const prepare = spyOn(spacesService.calendarInvitations, "prepareEventInvitationAttachment");
    const context = { ...userContext, idempotencyKey: "foreign-mail-identifiers" } satisfies CapabilityExecutionContext;

    const result = await spacesCapabilities.actions["event.invitation.prepare"].run(
      {
        itemId,
        mailboxId: "mail01",
        draftId: "draft1",
        senderIdentityId: "ident1",
        organizer: { name: "Organizer", address: "organizer@example.test" },
        attendees: [{ name: null, address: "attendee@example.test" }],
      },
      context,
    );

    expect(result).toMatchObject({ ok: false, error: { status: 404 } });
    expect(prepare).not.toHaveBeenCalled();
  });

  test("keeps task, event, comment, and output schemas strict", () => {
    expect(TaskCreateInputSchema.safeParse({ spaceId, columnId, title: "Task", startsAt: "2026-08-02T10:00:00.000Z" }).success).toBeFalse();
    expect(TaskUpdateInputSchema.safeParse({ itemId }).success).toBeFalse();
    expect(TaskUpdateInputSchema.safeParse({ itemId, columnId }).success).toBeFalse();
    expect(
      EventCreateInputSchema.safeParse({
        spaceId,
        columnId,
        title: "Event",
        startsAt: "2026-08-02T11:00:00.000Z",
        endsAt: "2026-08-02T10:00:00.000Z",
      }).success,
    ).toBeFalse();
    expect(EventUpdateInputSchema.safeParse({ itemId, startsAt: "2026-08-02T10:00:00.000Z" }).success).toBeFalse();
    expect(CommentCreateInputSchema.safeParse({ itemId, content: "x".repeat(5001) }).success).toBeFalse();
    expect(
      SpaceDetailDataSchema.safeParse({
        ...space,
        permission: "write",
        columns: [],
        tags: [],
      }).success,
    ).toBeFalse();
  });

  test("accepts only opaque v1 page cursors", () => {
    const cursor = Buffer.from(JSON.stringify({ v: 1, page: 3 }), "utf8").toString("base64url");
    expect(decodeSpacesCapabilityCursor(cursor)).toEqual({ ok: true, data: 3 });
    expect(decodeSpacesCapabilityCursor("not-a-cursor").ok).toBeFalse();
  });

  test("uses SQL-paginated space listing with the actor binding", async () => {
    const list = spyOn(spacesService.space, "listWithPermission").mockResolvedValue({
      items: [{ ...space, permission: "read" }],
      page: 2,
      perPage: 1,
      total: 3,
      hasNext: true,
    });
    const input = SpaceListInputSchema.parse({ limit: 1, cursor: encodePage(2) });

    const result = await spacesCapabilities.queries["space.list"].run(input, serviceAccountContext);

    expect(list).toHaveBeenCalledWith({
      subject: serviceAccountContext.accessSubject,
      boundSpaceId: spaceUuid,
      requiredLevel: "read",
      query: undefined,
      pagination: { page: 2, perPage: 1 },
    });
    expect(result).toMatchObject({
      ok: true,
      data: {
        data: [{ id: spaceId, permission: "read" }],
        refs: [{ type: "spaces.space", id: spaceId }],
        page: { hasMore: true },
      },
    });
  });

  test("projects Space detail tags without leaking internal IDs", async () => {
    spyOn(spacesService.space, "get").mockResolvedValue(space);
    spyOn(spacesService.space.permission, "get").mockResolvedValue("write");
    spyOn(spacesService.space, "getDetail").mockResolvedValue({
      ...space,
      columns: [{ id: columnUuid, spaceId: spaceUuid, name: "Todo", color: null, rank: "1024", isDone: false }],
      tags: [tag],
    });

    const result = await spacesCapabilities.queries["space.read"].run({ id: spaceId }, userContext);

    expect(result).toMatchObject({
      ok: true,
      data: { data: { id: spaceId, columns: [{ id: columnId }], tags: [{ id: tagId }] } },
    });
  });

  test("includes bounded authenticated attachment links when reading a task", async () => {
    spyOn(spacesService.item, "get").mockResolvedValue(task);
    spyOn(spacesService.space, "get").mockResolvedValue(space);
    spyOn(spacesService.space.permission, "get").mockResolvedValue("read");
    const listAttachments = spyOn(spacesService.item.attachments, "list").mockResolvedValue([
      {
        id: attachmentId,
        filename: "broken-dialog.webp",
        mimeType: "image/webp",
        sizeBytes: 42_000,
        kind: "image",
        createdAt,
      },
    ]);

    const result = await spacesCapabilities.queries["item.read"].run({ id: itemId }, userContext);

    expect(listAttachments).toHaveBeenCalledWith({ itemId: itemUuid });
    expect(result).toMatchObject({
      ok: true,
      data: {
        data: {
          id: itemId,
          attachments: [
            {
              id: attachmentId,
              links: [
                {
                  rel: "preview",
                  href: `/api/spaces/${spaceId}/items/${itemId}/attachments/${attachmentId}/content`,
                },
                {
                  rel: "download",
                  href: `/api/spaces/${spaceId}/items/${itemId}/attachments/${attachmentId}/content?download=true`,
                },
              ],
            },
          ],
        },
      },
    });
    expect(result.ok && capabilityResultSchema(ItemDataSchema).safeParse(result.data).success).toBeTrue();
  });

  test("reviews a calendar response with the public Space item link", async () => {
    spyOn(spacesService.calendarInvitations, "getCalendarResponseCommitContext").mockResolvedValue({
      ok: true,
      data: { itemId: itemUuid, spaceId: spaceUuid, title: event.title },
    });
    spyOn(spacesService.item, "get").mockResolvedValue(event);
    spyOn(spacesService.space, "get").mockResolvedValue(space);
    spyOn(spacesService.space.permission, "get").mockResolvedValue("write");

    const result = await spacesCapabilities.actions["calendar-invitation.response.commit"].review!(
      {
        mailboxId: "mail01",
        messageId: "msg001",
        participationStatus: "accepted",
        draftId: "draft1",
      },
      userContext,
    );

    expect(result).toMatchObject({
      ok: true,
      data: {
        approvalScope: `space:${spaceId}`,
        links: [{ rel: "open", href: `/app/spaces/${spaceId}?item=${itemId}` }],
      },
    });
  });

  test("shows task text and deadlines directly in the action review", async () => {
    spyOn(spacesService.item, "get").mockResolvedValue(task);
    spyOn(spacesService.space, "get").mockResolvedValue(space);
    spyOn(spacesService.space.permission, "get").mockResolvedValue("write");

    const result = await spacesCapabilities.actions["task.update"].review!(
      {
        itemId,
        description: "First line\n\nSecond line",
        deadline: "2026-08-20T15:00:00.000Z",
        estimatedDurationMinutes: 90,
      },
      userContext,
    );

    expect(result).toMatchObject({
      ok: true,
      data: {
        details: [
          { label: "Task", value: task.title },
          { label: "Description", value: "First line\n\nSecond line", display: "block" },
          { label: "Deadline", value: "2026-08-20T15:00:00.000Z", format: "date-time" },
          { label: "Estimated duration", value: "90 minutes" },
        ],
        approvalScope: `space:${spaceId}`,
      },
    });
  });

  test("scopes tag and comment approvals to their understandable work context", async () => {
    spyOn(spacesService.item, "get").mockResolvedValue(task);
    spyOn(spacesService.space, "get").mockResolvedValue(space);
    spyOn(spacesService.space.permission, "get").mockResolvedValue("write");
    spyOn(spacesService.space, "getDetail").mockResolvedValue({
      ...space,
      columns: [],
      tags: [tag],
    });

    const tags = await spacesCapabilities.actions["item.tags.set"].review!({ itemId, tagIds: [tagId] }, userContext);
    const commentReview = await spacesCapabilities.actions["comment.create"].review!({ itemId, content: "Draft is ready." }, userContext);

    expect(tags).toMatchObject({
      ok: true,
      data: {
        approvalScope: `space:${spaceId}`,
        details: [
          { label: "Item", value: task.title },
          { label: "Tags", value: tag.name },
        ],
      },
    });
    expect(commentReview).toMatchObject({
      ok: true,
      data: {
        approvalScope: `item:${itemId}`,
        details: [
          { label: "Item", value: task.title },
          { label: "Comment", value: "Draft is ready.", display: "block" },
        ],
      },
    });
  });

  test("returns a scope from every rememberable action review", async () => {
    const getItem = spyOn(spacesService.item, "get").mockResolvedValue(task);
    spyOn(spacesService.space, "get").mockResolvedValue(space);
    spyOn(spacesService.space.permission, "get").mockResolvedValue("write");
    spyOn(spacesService.space, "getDetail").mockResolvedValue({ ...space, columns: [], tags: [tag] });
    spyOn(spacesService.comment, "get").mockResolvedValue(comment);
    spyOn(spacesService.calendarInvitations, "getEventInvitationCommitContext").mockResolvedValue({
      ok: true,
      data: {
        deliveryId: "99999999-9999-4999-8999-999999999999",
        itemId: itemUuid,
        spaceId: spaceUuid,
        draftId: "draft1",
        title: event.title,
      },
    });
    spyOn(spacesService.calendarInvitations, "getCalendarResponseCommitContext").mockResolvedValue({
      ok: true,
      data: { itemId: itemUuid, spaceId: spaceUuid, title: event.title },
    });

    const results: CapabilityActionReviewResult[] = [
      await spacesCapabilities.actions["item.reference.add"].review!(
        { itemId, reference: { ref: { type: "notebooks.note", id: "Note01" }, label: "Release notes" } },
        userContext,
      ),
      await spacesCapabilities.actions["item.reference.remove"].review!(
        { itemId, ref: { type: "notebooks.note", id: "Note01" } },
        userContext,
      ),
      await spacesCapabilities.actions["item.tags.set"].review!({ itemId, tagIds: [tagId] }, userContext),
      await spacesCapabilities.actions["task.blocker.add"].review!({ itemId, blockerItemId: itemId }, userContext),
      await spacesCapabilities.actions["task.blocker.remove"].review!({ itemId, blockerItemId: itemId }, userContext),
      await spacesCapabilities.actions["task.update"].review!({ itemId, title: "Updated task" }, userContext),
      await spacesCapabilities.actions["task.set-completed"].review!({ itemId, completed: true }, userContext),
      await spacesCapabilities.actions["comment.create"].review!({ itemId, content: "Ready." }, userContext),
      await spacesCapabilities.actions["comment.update"].review!({ commentId, content: "Updated." }, userContext),
    ];

    getItem.mockResolvedValue(event);
    results.push(
      await spacesCapabilities.actions["event.update"].review!({ itemId, title: "Updated event" }, userContext),
      await spacesCapabilities.actions["event.invitation.commit"].review!(
        { deliveryId: "99999999-9999-4999-8999-999999999999" },
        userContext,
      ),
      await spacesCapabilities.actions["calendar-invitation.response.commit"].review!(
        { mailboxId: "mail01", messageId: "msg001", participationStatus: "accepted", draftId: "draft1" },
        userContext,
      ),
    );

    expect(results).toHaveLength(
      (Object.values(spacesCapabilities.actions) as CapabilityActionDefinition[]).filter((action) => action.approval === "rememberable")
        .length,
    );
    for (const [index, result] of results.entries()) {
      expect(result.ok).toBeTrue();
      if (result.ok) {
        expect(typeof result.data.approvalScope).toBe("string");
        const parsed = CapabilityActionReviewSchema.safeParse(result.data);
        if (!parsed.success) throw new Error(`Review ${index} is invalid: ${JSON.stringify(parsed.error.issues)}`);
      }
    }
  });

  test("reviews an existing calendar import against the internal Space boundary", async () => {
    spyOn(spacesService.space, "get").mockResolvedValue(space);
    spyOn(spacesService.space.permission, "get").mockResolvedValue("write");
    spyOn(spacesService.calendarInvitations, "previewCalendarInvitation").mockResolvedValue({
      ok: true,
      data: {
        invitation: {
          method: "request",
          uid: "planning@example.test",
          sequence: 1,
          status: "confirmed",
          title: event.title,
          description: null,
          location: null,
          url: null,
          startsAt: event.startsAt!,
          endsAt: event.endsAt!,
          allDay: false,
          recurrenceRule: null,
          organizer: null,
          attendees: [],
        },
        response: null,
        existing: {
          itemId: itemUuid,
          spaceId: spaceUuid,
          href: `/app/spaces/${spaceId}?item=${itemId}`,
          sequence: 1,
          method: "request",
        },
      },
    });

    const result = await spacesCapabilities.actions["calendar-invitation.import"].review!(
      {
        mailboxId: "mail01",
        messageId: "msg001",
        calendar: "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n",
        spaceId,
      },
      userContext,
    );

    expect(result).toMatchObject({
      ok: true,
      data: { links: [{ rel: "open", href: `/app/spaces/${spaceId}?item=${itemId}` }] },
    });
  });

  test("fails a resource-bound credential closed before reading another Space", async () => {
    const get = spyOn(spacesService.space, "get");

    const result = await spacesCapabilities.queries["space.read"].run({ id: otherSpaceId }, serviceAccountContext);

    expect(get).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, error: { code: "NOT_FOUND", message: "Space not found", status: 404 } });
  });

  test("rejects task-event cross-kind updates before mutation and audits the denial", async () => {
    spyOn(spacesService.item, "get").mockResolvedValue(event);
    spyOn(spacesService.space, "get").mockResolvedValue(space);
    spyOn(spacesService.space.permission, "get").mockResolvedValue("write");
    const update = spyOn(spacesService.item, "update");
    const recordDenied = spyOn(audit, "recordResult").mockImplementation(async ({ result }) => result);

    const result = await spacesCapabilities.actions["task.update"].run({ itemId, title: "Wrong kind" }, userContext);

    expect(update).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, error: { code: "BAD_INPUT" } });
    expect(recordDenied).toHaveBeenCalledWith(expect.objectContaining({ action: "spaces.capability.task.update" }));
  });

  test("creates a task through the existing service and audits the side effect", async () => {
    spyOn(spacesService.space, "get").mockResolvedValue(space);
    spyOn(spacesService.space.permission, "get").mockResolvedValue("write");
    const create = spyOn(spacesService.item, "create").mockResolvedValue({ ok: true, data: task });
    const recordAllowed = spyOn(audit, "recordResultAfterSideEffect").mockImplementation(async ({ result }) => result);

    const result = await spacesCapabilities.actions["task.create"].run(
      { spaceId, columnId, title: task.title, priority: "high" },
      userContext,
    );

    expect(create).toHaveBeenCalledWith({
      spaceId: spaceUuid,
      data: { columnId: columnUuid, title: task.title, priority: "high", tagIds: [] },
      createdBy: userId,
      actor: { kind: "user", id: userId },
    });
    expect(result).toMatchObject({
      ok: true,
      data: {
        data: { kind: "task", id: itemId },
        summary: `Created “${task.title}” in ${space.name}.`,
        refs: [{ type: "spaces.item", id: itemId }],
      },
    });
    expect(recordAllowed).toHaveBeenCalledWith(expect.objectContaining({ action: "spaces.capability.task.create" }));
  });

  test("sets item tags through the existing item update boundary", async () => {
    spyOn(spacesService.item, "get").mockResolvedValue(task);
    spyOn(spacesService.space, "get").mockResolvedValue(space);
    spyOn(spacesService.space.permission, "get").mockResolvedValue("write");
    const update = spyOn(spacesService.item, "update").mockResolvedValue({ ok: true, data: { ...task, tags: [tag] } });
    spyOn(audit, "recordResultAfterSideEffect").mockImplementation(async ({ result }) => result);

    const result = await spacesCapabilities.actions["item.tags.set"].run({ itemId, tagIds: [tagId] }, userContext);

    expect(update).toHaveBeenCalledWith({ id: itemUuid, data: { tagIds: [tagUuid] }, actor: { kind: "user", id: userId } });
    expect(result).toMatchObject({
      ok: true,
      data: {
        data: { id: itemId, tags: [{ id: tagId }] },
        summary: `Added #${tag.name} to “${task.title}”.`,
        refs: [{ type: "spaces.item", id: itemId }],
      },
    });
  });

  test("summarizes removal of a resource link without exposing its identifier", async () => {
    spyOn(spacesService.item, "get").mockResolvedValue(task);
    spyOn(spacesService.space, "get").mockResolvedValue(space);
    spyOn(spacesService.space.permission, "get").mockResolvedValue("write");
    spyOn(spacesService.item.references, "remove").mockResolvedValue(true);
    spyOn(audit, "recordResultAfterSideEffect").mockImplementation(async ({ result }) => result);

    const result = await spacesCapabilities.actions["item.reference.remove"].run(
      { itemId, ref: { type: "notebooks.note", id: "Note01" } },
      userContext,
    );

    expect(result).toMatchObject({ ok: true, data: { summary: `Removed a resource link from “${task.title}”.` } });
  });

  test("summarizes calendar imports and responses by their visible outcome", async () => {
    spyOn(spacesService.space, "get").mockResolvedValue(space);
    spyOn(spacesService.space.permission, "get").mockResolvedValue("write");
    spyOn(spacesService.item, "get").mockResolvedValue(event);
    spyOn(spacesService.calendarInvitations, "importCalendarInvitation").mockResolvedValue({
      ok: true,
      data: { itemId: itemUuid, spaceId: spaceUuid, href: `/app/spaces/${spaceId}?item=${itemId}`, outcome: "created" },
    });
    spyOn(spacesService.calendarInvitations, "getCalendarResponseCommitContext").mockResolvedValue({
      ok: true,
      data: { itemId: itemUuid, spaceId: spaceUuid, title: event.title },
    });
    spyOn(spacesService.calendarInvitations, "commitCalendarResponse").mockResolvedValue({
      ok: true,
      data: { participationStatus: "accepted", state: "drafted", draftId: "draft1", updatedAt: createdAt },
    });
    spyOn(audit, "recordResultAfterSideEffect").mockImplementation(async ({ result }) => result);

    const imported = await spacesCapabilities.actions["calendar-invitation.import"].run(
      {
        mailboxId: "mail01",
        messageId: "msg001",
        calendar: "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n",
        spaceId,
        conversation: { ref: { type: "mail.conversation", id: "Conv01" }, label: "Planning" },
      },
      userContext,
    );
    expect(imported).toMatchObject({ ok: true, data: { summary: `Added “${event.title}” to ${space.name}.` } });

    const response = await spacesCapabilities.actions["calendar-invitation.response.commit"].run(
      { mailboxId: "mail01", messageId: "msg001", participationStatus: "accepted", draftId: "draft1" },
      userContext,
    );
    expect(response).toMatchObject({
      ok: true,
      data: { summary: `Added your acceptance response for “${event.title}” to the mail draft.` },
    });
    if (imported.ok) {
      expect(
        capabilityResultSchema(spacesCapabilities.actions["calendar-invitation.import"].data).safeParse(imported.data).success,
      ).toBeTrue();
    }
    if (response.ok) {
      expect(
        capabilityResultSchema(spacesCapabilities.actions["calendar-invitation.response.commit"].data).safeParse(response.data).success,
      ).toBeTrue();
    }
  });

  test("reads comments through parent Space access without exposing avatar hashes", async () => {
    spyOn(spacesService.comment, "get").mockResolvedValue({ ...comment, canEdit: false, canDelete: false });
    spyOn(spacesService.item, "get").mockResolvedValue(task);
    spyOn(spacesService.space, "get").mockResolvedValue(space);
    spyOn(spacesService.space.permission, "get").mockResolvedValue("read");

    const result = await spacesCapabilities.queries["comment.read"].run({ id: commentId }, serviceAccountContext);

    expect(result).toMatchObject({
      ok: true,
      data: {
        data: { id: commentId, itemId, content: comment.content, canEdit: false, canDelete: false },
        refs: [
          { type: "spaces.comment", id: commentId },
          { type: "spaces.item", id: itemId },
        ],
      },
    });
    expect(result.ok && "userAvatarHash" in result.data.data).toBeFalse();
  });

  test("keeps comment writes user-backed and propagates the existing delete window", async () => {
    const recordDenied = spyOn(audit, "recordResult").mockImplementation(async ({ result }) => result);
    const create = spyOn(spacesService.comment, "create");

    const denied = await spacesCapabilities.actions["comment.create"].run({ itemId, content: "No author" }, serviceAccountContext);

    expect(create).not.toHaveBeenCalled();
    expect(denied).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });

    spyOn(spacesService.comment, "get").mockResolvedValue(comment);
    spyOn(spacesService.item, "get").mockResolvedValue(task);
    spyOn(spacesService.space, "get").mockResolvedValue(space);
    spyOn(spacesService.space.permission, "get").mockResolvedValue("write");
    spyOn(spacesService.comment, "remove").mockResolvedValue({
      ok: false,
      error: "Comments can only be deleted within 10 minutes",
      status: 403,
    });

    const expired = await spacesCapabilities.actions["comment.delete"].run({ commentId }, userContext);

    expect(expired).toMatchObject({ ok: false, error: { code: "FORBIDDEN", status: 403 } });
    expect(recordDenied).toHaveBeenCalledTimes(2);
  });

  test("keeps compact item and comment pages below the capability transport limit", () => {
    const tasks = Array.from({ length: 50 }, () => ({
      kind: "task" as const,
      id: itemId,
      spaceId,
      columnId,
      title: "t".repeat(200),
      descriptionPreview: "d".repeat(1000),
      descriptionTruncated: true,
      deadline: null,
      estimatedDurationMinutes: null,
      activeBlockerCount: 0,
      priority: "urgent" as const,
      completedAt: null,
      assignees: Array.from({ length: 3 }, () => ({ id: userId, displayName: "a".repeat(100) })),
      tags: Array.from({ length: 3 }, () => ({ id: itemId, name: "n".repeat(50), color: "c".repeat(20) })),
      relationsTruncated: true,
      createdAt,
      updatedAt: createdAt,
      links: [{ rel: "open" as const, href: `/app/spaces/${spaceId}?item=${itemId}` }],
    }));
    const comments = Array.from({ length: 100 }, () => ({
      id: commentId,
      itemId,
      recurrenceId: null,
      userId,
      userName: "Agent",
      content: "c".repeat(1000),
      contentTruncated: true,
      createdAt,
      updatedAt: createdAt,
      canEdit: true,
      canDelete: true,
    }));
    const events = tasks.map(
      ({
        kind: _kind,
        deadline: _deadline,
        estimatedDurationMinutes: _estimatedDurationMinutes,
        activeBlockerCount: _activeBlockerCount,
        priority: _priority,
        ...task
      }) => ({
        ...task,
        kind: "event" as const,
        location: "l".repeat(200),
        locationTruncated: true,
        url: `https://example.test/${"u".repeat(470)}`,
        urlTruncated: true,
        startsAt: createdAt,
        endsAt: createdAt,
        allDay: false,
        hasRecurrence: true,
      }),
    );
    const parsedTasks = TaskListDataSchema.parse(tasks);
    const parsedEvents = EventListDataSchema.parse(events);
    const parsedComments = CommentListDataSchema.parse(comments);
    expect(Buffer.byteLength(JSON.stringify({ data: parsedTasks }), "utf8")).toBeLessThan(CAPABILITY_MAX_RESULT_BYTES);
    expect(Buffer.byteLength(JSON.stringify({ data: parsedEvents }), "utf8")).toBeLessThan(CAPABILITY_MAX_RESULT_BYTES);
    expect(Buffer.byteLength(JSON.stringify({ data: parsedComments }), "utf8")).toBeLessThan(CAPABILITY_MAX_RESULT_BYTES);
    expect(TaskListInputSchema.safeParse({ spaceId, limit: 101 }).success).toBeFalse();
  });
});

const encodePage = (page: number) => Buffer.from(JSON.stringify({ v: 1, page }), "utf8").toString("base64url");
