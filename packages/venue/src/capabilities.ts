import { err, fail, ok } from "@k2b/stdlib";
import {
  type CapabilityExecutionContext,
  type CloudResourceView,
  capabilityPage,
  defineCapabilities,
  UniversalSearchDataSchema,
  type UniversalSearchInput,
  UniversalSearchInputSchema,
} from "@k2b/cloud/contracts";
import type { z } from "zod";
import { type VenueAccessScope, venueAccessScopeFor } from "./access-control";
import {
  AssignmentActionDataSchema,
  AssignmentCancelDataSchema,
  AssignmentCancelInputSchema,
  AssignmentDataSchema,
  AssignmentFreeSignupInputSchema,
  AssignmentListDataSchema,
  AssignmentMineInputSchema,
  AssignmentReadInputSchema,
  AssignmentSignupInputSchema,
  FeedbackSummaryDataSchema,
  ShiftDataSchema,
  ShiftListDataSchema,
  ShiftListInputSchema,
  ShiftReadInputSchema,
  VenueDataSchema,
  VenueListDataSchema,
  VenueListInputSchema,
  VenueReadInputSchema,
  VenueStatusDataSchema,
  VenueTargetInputSchema,
} from "./capability-contracts";
import { venueCapabilityPresentation } from "./capability-presentation";
import type { ShiftAssignment, Venue } from "./contracts";
import { type UpcomingSlotSummary, venueService } from "./service";
import { venueMessages } from "./messages";

const messagesFor = (context: CapabilityExecutionContext) => venueMessages.resolve(context.locale ? [context.locale] : []).t;

const permissionLabel = (permission: Venue["permission"], t: ReturnType<typeof messagesFor>): string =>
  permission === "admin" ? t.admin : permission === "write" ? t.staff : permission === "read" ? t.read : t.public;

const venueHref = (venueId: string): string => `/app/venue/${venueId}`;
const publicVenueHref = (venueId: string): string => `/app/venue/public/${venueId}`;
const visiblePermission = (venue: Venue) =>
  venue.permission === "read" || venue.permission === "write" || venue.permission === "admin" ? venue.permission : null;
type CapabilityVenue = Venue & { publicId: string };
const openVenueHref = (venue: CapabilityVenue): string =>
  visiblePermission(venue) ? venueHref(venue.publicId) : publicVenueHref(venue.publicId);
const shiftHref = (venueId: string): string => `${venueHref(venueId)}/shifts`;
const myShiftsHref = (venueId: string): string => `${venueHref(venueId)}/my-shifts`;

const encodeCursor = (offset: number): string => Buffer.from(JSON.stringify({ v: 1, offset }), "utf8").toString("base64url");

const decodeCursor = (cursor: string | undefined) => {
  if (!cursor) return ok(0);
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { v?: unknown; offset?: unknown };
    return value.v === 1 && Number.isSafeInteger(value.offset) && Number(value.offset) >= 0 && Number(value.offset) <= 10_000
      ? ok(Number(value.offset))
      : fail(err.badInput("Invalid cursor"));
  } catch {
    return fail(err.badInput("Invalid cursor"));
  }
};

const pageResult = <T>(items: T[], offset: number, limit: number) => {
  const data = items.slice(0, limit);
  const hasMore = items.length > limit;
  return { data, page: capabilityPage(hasMore ? encodeCursor(offset + data.length) : undefined) };
};

const scopeFor = (context: CapabilityExecutionContext) => venueAccessScopeFor(context.actor, context.accessSubject);

const mapVenue = (venue: CapabilityVenue) => ({
  id: venue.publicId,
  slug: venue.slug.slice(0, 80),
  name: venue.name.slice(0, 160),
  icon: venue.icon.slice(0, 120),
  description: venue.description?.slice(0, 1_000) ?? null,
  timezone: venue.timezone.slice(0, 80),
  openMode: venue.openMode,
  signupMode: venue.signupMode,
  publicEnabled: venue.publicEnabled,
  feedbackEnabled: venue.feedbackEnabled,
  permission: visiblePermission(venue),
  createdAt: venue.createdAt,
  updatedAt: venue.updatedAt,
});

const requireVenue = async (venueId: string, scope: VenueAccessScope, permission: "read" | "write", allowPublic = false) => {
  const internalId = await venueService.publicResources.resolve("venues", venueId);
  if (!internalId) return fail(err.notFound("Venue"));
  if (scope.serviceAccountResourceId && scope.serviceAccountResourceId !== internalId) return fail(err.forbidden("Access denied"));
  const venue = await venueService.venues.getSummary(internalId, scope);
  if (!venue) return fail(err.notFound("Venue"));
  const access = await venueService.access.require(internalId, scope, permission);
  if (access.ok || (allowPublic && venue.publicEnabled && !scope.serviceAccountResourceId)) return ok({ ...venue, publicId: venueId });
  return fail(err.notFound("Venue"));
};

const runVenueSearch = async (input: UniversalSearchInput, context: CapabilityExecutionContext) => {
  const t = messagesFor(context);
  const scope = scopeFor(context);
  if (!scope.ok) return ok({ data: [] });
  const [accessible, publicVenues] = await Promise.all([
    venueService.venues.discover(scope.data, { query: input.query, limit: input.limit }),
    scope.data.serviceAccountResourceId
      ? Promise.resolve([])
      : venueService.venues.discoverPublic({ query: input.query, limit: input.limit }),
  ]);
  const projectedPublic = await venueService.publicResources.projectVenues(publicVenues);
  const projectedAccessible = await venueService.publicResources.projectVenues(accessible);
  const venues = new Map(projectedPublic.map((venue) => [venue.id, { ...venue, publicId: venue.id }]));
  for (const venue of projectedAccessible) venues.set(venue.id, { ...venue, publicId: venue.id });
  const data: CloudResourceView[] = [...venues.values()]
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, input.limit)
    .map((venue) => ({
      ref: { type: "venue.venue", id: venue.publicId },
      title: venue.name.slice(0, 500),
      preview: venue.description?.slice(0, 2_000),
      icon: venue.icon.slice(0, 120),
      priority: 7,
      metadata: [
        { label: t.timezone, value: venue.timezone.slice(0, 1_000) },
        { label: t.capabilityAccess, value: permissionLabel(venue.permission, t) },
      ],
      links: [{ rel: "open", href: openVenueHref(venue) }],
    }));
  return ok({ data });
};

const runVenueList = async (input: z.infer<typeof VenueListInputSchema>, context: CapabilityExecutionContext) => {
  const cursor = decodeCursor(input.cursor);
  if (!cursor.ok) return cursor;
  const scope = scopeFor(context);
  if (!scope.ok) return scope;
  const venues = await venueService.venues.discover(scope.data, {
    query: input.query,
    limit: input.limit + 1,
    offset: cursor.data,
  });
  const publicVenues = await venueService.publicResources.projectVenues(venues);
  const page = pageResult(
    publicVenues.map((venue) => ({
      ...mapVenue({ ...venue, publicId: venue.id }),
      ref: { type: "venue.venue" as const, id: venue.id },
      links: [{ rel: "open" as const, href: openVenueHref({ ...venue, publicId: venue.id }) }],
    })),
    cursor.data,
    input.limit,
  );
  return ok({
    ...page,
    refs: page.data.map((venue) => ({ type: "venue.venue" as const, id: venue.id })),
  });
};

const runVenueRead = async (input: z.infer<typeof VenueReadInputSchema>, context: CapabilityExecutionContext) => {
  const t = messagesFor(context);
  const scope = scopeFor(context);
  if (!scope.ok) return scope;
  const venue = await requireVenue(input.id, scope.data, "read", true);
  if (!venue.ok) return venue;
  return ok({
    data: mapVenue(venue.data),
    summary: t.capabilityReadVenue({ name: venue.data.name }),
    refs: [{ type: "venue.venue", id: venue.data.publicId }],
    links: [{ rel: "open" as const, href: openVenueHref(venue.data) }],
  });
};

const runVenueStatus = async (input: z.infer<typeof VenueTargetInputSchema>, context: CapabilityExecutionContext) => {
  const t = messagesFor(context);
  const scope = scopeFor(context);
  if (!scope.ok) return scope;
  const venue = await requireVenue(input.venueId, scope.data, "read", true);
  if (!venue.ok) return venue;
  const status = await venueService.status(venue.data, new Date(), false, context.locale);
  return ok({
    data: {
      venueId: venue.data.publicId,
      timezone: venue.data.timezone.slice(0, 80),
      open: status.open,
      spontaneousOpen: status.spontaneousOpen,
      statusLabel: status.statusLabel.slice(0, 160),
      todayLabel: status.todayLabel.slice(0, 500),
      nextOpeningLabel: status.nextOpeningLabel?.slice(0, 500) ?? null,
      activeWindowLabel: status.activeWindowLabel?.slice(0, 500) ?? null,
      upcomingOpenings: status.upcomingOpenings.slice(0, 8).map((opening) => ({
        kind: opening.kind,
        title: opening.title.slice(0, 160),
        startsAt: opening.startsAt,
        endsAt: opening.endsAt,
      })),
    },
    summary: t.capabilityVenueStatus({ name: venue.data.name, status: status.statusLabel }),
    refs: [{ type: "venue.venue", id: venue.data.publicId }],
    links: [{ rel: "status" as const, href: openVenueHref(venue.data) }],
  });
};

const mapShift = (slot: UpcomingSlotSummary) => ({
  venueId: slot.template.venueId,
  templateId: slot.template.id,
  title: slot.template.title.slice(0, 160),
  date: slot.date,
  startsAt: slot.startsAt,
  endsAt: slot.endsAt,
  assignedCount: slot.assignedCount,
  minPeople: slot.minPeople,
  maxPeople: slot.maxPeople,
  missingPeople: slot.missingPeople,
  full: slot.full,
  currentUserAssignmentId: slot.currentUserAssignmentId,
});

const runShiftList = async (input: z.infer<typeof ShiftListInputSchema>, context: CapabilityExecutionContext) => {
  const cursor = decodeCursor(input.cursor);
  if (!cursor.ok) return cursor;
  const scope = scopeFor(context);
  if (!scope.ok) return scope;
  const venue = await requireVenue(input.venueId, scope.data, "read");
  if (!venue.ok) return venue;
  const templates = await venueService.templates.list(venue.data.id, { limit: 101 });
  if (templates.length > 100) return fail(err.badInput("This Venue has too many active shift templates"));
  const internalSlots = await venueService.shifts.listSummary(venue.data, {
    startDate: input.startDate,
    days: input.days,
    templates,
    currentUserId: context.user?.id ?? null,
  });
  const slots = await venueService.publicResources.projectSlotSummaries(internalSlots);
  const page = pageResult(slots.slice(cursor.data, cursor.data + input.limit + 1).map(mapShift), cursor.data, input.limit);
  return ok({
    ...page,
    refs: [{ type: "venue.venue" as const, id: venue.data.publicId }],
    links: [{ rel: "open" as const, href: shiftHref(venue.data.publicId) }],
  });
};

type PersonalAssignment = Awaited<ReturnType<typeof venueService.assignments.mine>>[number];

const mapPersonalAssignment = (assignment: PersonalAssignment) => ({
  id: assignment.id,
  venueId: assignment.venueId,
  venueName: assignment.venueName.slice(0, 160),
  venueTimezone: assignment.venueTimezone.slice(0, 80),
  templateId: assignment.templateId,
  startsAt: assignment.startsAt,
  endsAt: assignment.endsAt,
  note: assignment.note?.slice(0, 500) ?? null,
  createdAt: assignment.createdAt,
  updatedAt: assignment.updatedAt,
});

const runAssignmentRead = async (input: z.infer<typeof AssignmentReadInputSchema>, context: CapabilityExecutionContext) => {
  const t = messagesFor(context);
  if (!context.user) return fail(err.forbidden("Venue assignments require a user-backed actor"));
  const assignmentId = await venueService.publicResources.resolve("assignments", input.id);
  if (!assignmentId) return fail(err.notFound("Shift assignment"));
  const assignment = await venueService.assignments.getPersonalById(assignmentId, context.user.id);
  if (!assignment) return fail(err.notFound("Shift assignment"));
  const publicAssignment = (await venueService.publicResources.projectAssignments([assignment]))[0]!;
  const scope = scopeFor(context);
  if (!scope.ok) return scope;
  const venue = await requireVenue(publicAssignment.venueId, scope.data, "read");
  if (!venue.ok) return venue;
  return ok({
    data: mapPersonalAssignment(publicAssignment),
    summary: t.capabilityReadAssignment({ name: publicAssignment.venueName }),
    refs: [{ type: "venue.assignment", id: publicAssignment.id }],
    links: [{ rel: "open" as const, href: myShiftsHref(publicAssignment.venueId) }],
  });
};

const runAssignmentMine = async (input: z.infer<typeof AssignmentMineInputSchema>, context: CapabilityExecutionContext) => {
  if (!context.user) return fail(err.forbidden("Venue assignments require a user-backed actor"));
  const scope = scopeFor(context);
  if (!scope.ok) return scope;
  const selectedVenue = input.venueId ? await requireVenue(input.venueId, scope.data, "read") : null;
  if (selectedVenue && !selectedVenue.ok) return selectedVenue;
  const venueId = scope.data.serviceAccountResourceId ?? selectedVenue?.data.id;
  let publicVenueId = selectedVenue?.data.publicId;
  if (scope.data.serviceAccountResourceId) {
    const internalVenue = await venueService.venues.getSummary(scope.data.serviceAccountResourceId, scope.data);
    if (!internalVenue) return fail(err.notFound("Venue"));
    const access = await venueService.access.require(internalVenue.id, scope.data, "read");
    if (!access.ok) return access;
    publicVenueId = (await venueService.publicResources.projectVenues([internalVenue]))[0]!.id;
  }
  const cursor = decodeCursor(input.cursor);
  if (!cursor.ok) return cursor;
  const from = input.from ? new Date(input.from) : new Date();
  const to = new Date(from.getTime() + input.days * 86_400_000);
  const assignments = await venueService.assignments.mine(context.user.id, {
    venueId,
    from,
    to,
    limit: input.limit + 1,
    offset: cursor.data,
  });
  const publicAssignments = await venueService.publicResources.projectAssignments(assignments);
  const page = pageResult(
    publicAssignments.map((assignment) => ({
      ...mapPersonalAssignment(assignment),
      ref: { type: "venue.assignment" as const, id: assignment.id },
    })),
    cursor.data,
    input.limit,
  );
  return ok({
    ...page,
    refs: page.data.map((assignment) => ({ type: "venue.assignment" as const, id: assignment.id })),
    ...(publicVenueId ? { links: [{ rel: "open" as const, href: myShiftsHref(publicVenueId) }] } : {}),
  });
};

const runFeedbackSummary = async (input: z.infer<typeof VenueTargetInputSchema>, context: CapabilityExecutionContext) => {
  const t = messagesFor(context);
  const scope = scopeFor(context);
  if (!scope.ok) return scope;
  const venue = await requireVenue(input.venueId, scope.data, "read");
  if (!venue.ok) return venue;
  const feedback = await venueService.feedback.summary(venue.data.id, { summaryDays: 30 });
  return ok({
    data: {
      venueId: venue.data.publicId,
      count: feedback.summary.count,
      averageRating: feedback.summary.averageRating,
      buckets: feedback.summary.buckets.slice(0, 31),
    },
    summary:
      feedback.summary.count === 0
        ? t.capabilityFeedbackEmpty({ name: venue.data.name })
        : t.capabilityFeedback({ name: venue.data.name, average: feedback.summary.averageRating, count: feedback.summary.count }),
    refs: [{ type: "venue.venue", id: venue.data.publicId }],
    links: [{ rel: "open" as const, href: `${venueHref(venue.data.publicId)}/feedback` }],
  });
};

const requireUserAndVenue = async (venueId: string, context: CapabilityExecutionContext, permission: "read" | "write") => {
  if (!context.user) return fail(err.forbidden("Venue assignments require a user-backed actor"));
  const scope = scopeFor(context);
  if (!scope.ok) return scope;
  const venue = await requireVenue(venueId, scope.data, permission);
  if (!venue.ok) return venue;
  return ok({ user: context.user, venue: venue.data });
};

const mapCreatedAssignment = (assignment: ShiftAssignment, venue: Venue) => ({
  id: assignment.id,
  venueId: assignment.venueId,
  venueName: venue.name.slice(0, 160),
  venueTimezone: venue.timezone.slice(0, 80),
  templateId: assignment.templateId,
  startsAt: assignment.startsAt,
  endsAt: assignment.endsAt,
  note: assignment.note?.slice(0, 500) ?? null,
  createdAt: assignment.createdAt,
  updatedAt: assignment.updatedAt,
});

const runShiftRead = async (input: z.infer<typeof ShiftReadInputSchema>, context: CapabilityExecutionContext) => {
  const t = messagesFor(context);
  const scope = scopeFor(context);
  if (!scope.ok) return scope;
  const venue = await requireVenue(input.venueId, scope.data, "read");
  if (!venue.ok) return venue;
  const templateId = await venueService.publicResources.resolveOwned("templates", venue.data.id, input.templateId);
  if (!templateId) return fail(err.notFound("Shift"));
  const template = await venueService.templates.get(templateId);
  if (!template || !template.active) return fail(err.notFound("Shift"));
  const slots = await venueService.shifts.listSummary(venue.data, {
    startDate: input.date,
    days: 1,
    templates: [template],
    currentUserId: context.user?.id ?? null,
  });
  const projected = await venueService.publicResources.projectSlotSummaries(slots);
  const shift = projected.find((slot) => slot.template.id === input.templateId && slot.date === input.date);
  return shift
    ? ok({
        data: mapShift(shift),
        summary: t.capabilityReadShift({ title: shift.template.title, venue: venue.data.name, date: shift.date }),
        refs: [{ type: "venue.venue", id: venue.data.publicId }],
        links: [{ rel: "open" as const, href: shiftHref(venue.data.publicId) }],
      })
    : fail(err.notFound("Shift"));
};

const validateFreeSignupWindow = (input: z.infer<typeof AssignmentFreeSignupInputSchema>) => {
  const start = new Date(input.startsAt);
  const end = new Date(input.endsAt);
  const duration = end.getTime() - start.getTime();
  if (start.getTime() < Date.now() - 60_000) return fail(err.badInput("Free shifts cannot start in the past"));
  if (duration < 60_000 || duration > 24 * 60 * 60 * 1_000) {
    return fail(err.badInput("Free shifts must last between one minute and 24 hours"));
  }
  if (start.getTime() > Date.now() + 366 * 86_400_000) return fail(err.badInput("Free shifts must start within the next 366 days"));
  return ok({ start, end });
};

const runAssignmentSignup = async (input: z.infer<typeof AssignmentSignupInputSchema>, context: CapabilityExecutionContext) => {
  const t = messagesFor(context);
  const actor = await requireUserAndVenue(input.venueId, context, "write");
  if (!actor.ok) return actor;
  if (actor.data.venue.signupMode === "free") return fail(err.badInput("Template shift signup is disabled for this Venue"));
  const templateId = await venueService.publicResources.resolveOwned("templates", actor.data.venue.id, input.templateId);
  if (!templateId) return fail(err.notFound("Shift"));
  const template = await venueService.templates.get(templateId);
  if (!template || !template.active) return fail(err.notFound("Shift"));
  const result = await venueService.assignments.signupTemplate(actor.data.venue, templateId, { date: input.date }, actor.data.user);
  if (!result.ok) return result;
  const assignment = (await venueService.publicResources.projectAssignments([result.data]))[0]!;
  return ok({
    data: mapCreatedAssignment(assignment, actor.data.venue),
    summary: t.capabilitySignedUp({ title: template.title, venue: actor.data.venue.name }),
    refs: [
      { type: "venue.venue", id: actor.data.venue.publicId },
      { type: "venue.assignment", id: assignment.id },
    ],
    links: [{ rel: "open" as const, href: myShiftsHref(actor.data.venue.publicId) }],
  });
};

const runAssignmentFreeSignup = async (input: z.infer<typeof AssignmentFreeSignupInputSchema>, context: CapabilityExecutionContext) => {
  const t = messagesFor(context);
  const actor = await requireUserAndVenue(input.venueId, context, "write");
  if (!actor.ok) return actor;
  if (actor.data.venue.signupMode === "templates") return fail(err.badInput("Free shift signup is disabled for this Venue"));
  const window = validateFreeSignupWindow(input);
  if (!window.ok) return window;
  const result = await venueService.assignments.signupFree(actor.data.venue.id, input, actor.data.user);
  if (!result.ok) return result;
  const assignment = (await venueService.publicResources.projectAssignments([result.data]))[0]!;
  return ok({
    data: mapCreatedAssignment(assignment, actor.data.venue),
    summary: t.capabilityFreeSignedUp({ venue: actor.data.venue.name }),
    refs: [
      { type: "venue.venue", id: actor.data.venue.publicId },
      { type: "venue.assignment", id: assignment.id },
    ],
    links: [{ rel: "open" as const, href: myShiftsHref(actor.data.venue.publicId) }],
  });
};

const runAssignmentCancel = async (input: z.infer<typeof AssignmentCancelInputSchema>, context: CapabilityExecutionContext) => {
  const t = messagesFor(context);
  const actor = await requireUserAndVenue(input.venueId, context, "read");
  if (!actor.ok) return actor;
  const assignmentId = await venueService.publicResources.resolveOwned("assignments", actor.data.venue.id, input.assignmentId);
  if (!assignmentId) return fail(err.notFound("Shift assignment"));
  const result = await venueService.assignments.cancel(actor.data.venue.id, assignmentId, actor.data.user, false);
  if (!result.ok) return result;
  return ok({
    data: { assignmentId: input.assignmentId, cancelled: true as const },
    summary: t.capabilityCancelled({ venue: actor.data.venue.name }),
    refs: [{ type: "venue.venue", id: actor.data.venue.publicId }],
    links: [{ rel: "open" as const, href: myShiftsHref(actor.data.venue.publicId) }],
  });
};

export const venueCapabilities = defineCapabilities({
  protocolVersion: 1,
  presentation: venueCapabilityPresentation,
  types: {
    venue: {
      title: "Venue",
      description: "A public or permission-scoped place with opening and staffing rules.",
      icon: "ti ti-building-carousel",
      reader: "venue.read",
    },
    assignment: {
      title: "Shift assignment",
      description: "A user's concrete signup for a Venue shift.",
      icon: "ti ti-user-check",
      reader: "assignment.read",
    },
  },
  queries: {
    "venue.search": {
      title: "Search Venues",
      description:
        "Find a public or accessible Venue by name, slug, or description when its ID is unknown. Use returned venue.venue refs with venue.read, venue.status, shift.list, or feedback.summary.",
      input: UniversalSearchInputSchema,
      data: UniversalSearchDataSchema,
      openWorld: false,
      universalSearch: { tags: [{ tag: "venue", title: "Venues", description: "Show Venues only.", aliases: ["venues", "place"] }] },
      run: runVenueSearch,
    },
    "venue.list": {
      title: "List accessible Venues",
      description:
        "Normal entry for permission-scoped Venue work. List accessible Venues and use returned venue.venue refs or IDs with venue.read, venue.status, shift.list, assignment.mine, or feedback.summary.",
      input: VenueListInputSchema,
      data: VenueListDataSchema,
      openWorld: false,
      run: runVenueList,
    },
    "venue.read": {
      title: "Read Venue",
      description: "Read one venue.venue ref returned by venue.list or venue.search, without media or secret calendar tokens.",
      input: VenueReadInputSchema,
      data: VenueDataSchema,
      openWorld: false,
      run: runVenueRead,
    },
    "venue.status": {
      title: "Get Venue status",
      description:
        "Get current opening status, today's hours, and upcoming openings for a known Venue. Get venueId from venue.list or venue.search.",
      input: VenueTargetInputSchema,
      data: VenueStatusDataSchema,
      openWorld: false,
      run: runVenueStatus,
    },
    "shift.list": {
      title: "List Venue shifts",
      description:
        "List dated shifts for a known Venue without participant identities. Get venueId from venue.list or venue.search; use each returned venueId, templateId, and date with shift.read or assignment.signup.",
      input: ShiftListInputSchema,
      data: ShiftListDataSchema,
      openWorld: false,
      run: runShiftList,
    },
    "shift.read": {
      title: "Read Venue shift",
      description:
        "Specialized occurrence lookup: read one dated Venue shift using the venueId, templateId, and date returned together by List Venue shifts.",
      input: ShiftReadInputSchema,
      data: ShiftDataSchema,
      openWorld: false,
      run: runShiftRead,
    },
    "assignment.mine": {
      title: "List my assignments",
      description:
        "List the current user's assignments, optionally for a venueId from venue.list or venue.search. Use returned venue.assignment refs with assignment.read or assignment.cancel.",
      input: AssignmentMineInputSchema,
      data: AssignmentListDataSchema,
      openWorld: false,
      run: runAssignmentMine,
    },
    "assignment.read": {
      title: "Read my assignment",
      description: "Read one owned venue.assignment ref returned by assignment.mine or an assignment signup Action.",
      input: AssignmentReadInputSchema,
      data: AssignmentDataSchema,
      openWorld: false,
      run: runAssignmentRead,
    },
    "feedback.summary": {
      title: "Get Venue feedback summary",
      description:
        "Read 30-day rating aggregates for a known Venue without loading anonymous comments. Get venueId from venue.list or venue.search.",
      input: VenueTargetInputSchema,
      data: FeedbackSummaryDataSchema,
      openWorld: false,
      run: runFeedbackSummary,
    },
  },
  actions: {
    "assignment.signup": {
      title: "Sign up for Venue shift",
      description: "Create one non-idempotent assignment for a dated template occurrence returned by shift.list.",
      input: AssignmentSignupInputSchema,
      data: AssignmentActionDataSchema,
      destructive: false,
      openWorld: false,
      idempotency: "none",
      review: async (input, context) => {
        const t = messagesFor(context);
        const actor = await requireUserAndVenue(input.venueId, context, "write");
        if (!actor.ok) return actor;
        if (actor.data.venue.signupMode === "free") return fail(err.badInput("Template shift signup is disabled for this Venue"));
        const templateId = await venueService.publicResources.resolveOwned("templates", actor.data.venue.id, input.templateId);
        if (!templateId) return fail(err.notFound("Shift"));
        const templates = await venueService.templates.list(actor.data.venue.id, { limit: 101 });
        if (templates.length > 100) return fail(err.badInput("This Venue has too many active shift templates"));
        const internalShifts = await venueService.shifts.listSummary(actor.data.venue, {
          startDate: input.date,
          days: 1,
          templates,
          currentUserId: actor.data.user.id,
        });
        const shifts = await venueService.publicResources.projectSlotSummaries(internalShifts);
        const shift = shifts.find((entry) => entry.template.id === input.templateId && entry.date === input.date);
        if (!shift) return fail(err.notFound("Shift"));
        if (shift.currentUserAssignmentId) return fail(err.badInput("You are already signed up for this shift"));
        if (shift.full) return fail(err.badInput("This shift is already full"));
        return ok({
          message: t.capabilitySignupReview({ title: shift.template.title, venue: actor.data.venue.name }),
          details: [
            { label: t.venueFallbackTitle, value: actor.data.venue.name },
            { label: t.shift, value: shift.template.title },
            { label: t.starts, value: shift.startsAt, format: "date-time" },
            { label: t.ends, value: shift.endsAt, format: "date-time" },
          ],
          links: [{ rel: "open" as const, href: shiftHref(actor.data.venue.publicId) }],
        });
      },
      run: runAssignmentSignup,
    },
    "assignment.signup_free": {
      title: "Sign up for free Venue shift",
      description: "Create one non-idempotent free assignment with exact instants, for at most 24 hours within the next year.",
      input: AssignmentFreeSignupInputSchema,
      data: AssignmentActionDataSchema,
      destructive: false,
      openWorld: false,
      idempotency: "none",
      review: async (input, context) => {
        const t = messagesFor(context);
        const actor = await requireUserAndVenue(input.venueId, context, "write");
        if (!actor.ok) return actor;
        if (actor.data.venue.signupMode === "templates") return fail(err.badInput("Free shift signup is disabled for this Venue"));
        const window = validateFreeSignupWindow(input);
        if (!window.ok) return window;
        return ok({
          message: t.capabilityFreeReview({ venue: actor.data.venue.name }),
          details: [
            { label: t.venueFallbackTitle, value: actor.data.venue.name },
            { label: t.timezone, value: actor.data.venue.timezone },
            { label: t.starts, value: window.data.start.toISOString(), format: "date-time" },
            { label: t.ends, value: window.data.end.toISOString(), format: "date-time" },
            ...(input.note ? [{ label: t.privateNote, value: input.note, display: "block" as const }] : []),
          ],
          links: [{ rel: "open" as const, href: myShiftsHref(actor.data.venue.publicId) }],
        });
      },
      run: runAssignmentFreeSignup,
    },
    "assignment.cancel": {
      title: "Cancel my shift assignment",
      description: "Delete only the current user-backed actor's own assignment. This action is not idempotent.",
      input: AssignmentCancelInputSchema,
      data: AssignmentCancelDataSchema,
      destructive: true,
      openWorld: false,
      idempotency: "none",
      review: async (input, context) => {
        const t = messagesFor(context);
        const actor = await requireUserAndVenue(input.venueId, context, "read");
        if (!actor.ok) return actor;
        const assignmentId = await venueService.publicResources.resolveOwned("assignments", actor.data.venue.id, input.assignmentId);
        if (!assignmentId) return fail(err.notFound("Shift assignment"));
        const assignment = await venueService.assignments.getPersonal(actor.data.venue.id, assignmentId, actor.data.user.id);
        if (!assignment) return fail(err.notFound("Shift assignment"));
        return ok({
          message: t.capabilityCancelReview({ venue: actor.data.venue.name }),
          details: [
            { label: t.venueFallbackTitle, value: actor.data.venue.name },
            { label: t.starts, value: assignment.startsAt, format: "date-time" },
            { label: t.ends, value: assignment.endsAt, format: "date-time" },
          ],
          links: [{ rel: "open" as const, href: myShiftsHref(actor.data.venue.publicId) }],
        });
      },
      run: runAssignmentCancel,
    },
  },
});
