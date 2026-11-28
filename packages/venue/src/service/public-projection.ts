import type {
  DateOverride,
  FeedbackEntry,
  OpeningRule,
  PublicSection,
  PublicStatus,
  ShiftAssignment,
  ShiftTemplate,
  UpcomingSlot,
  Venue,
  VenueDashboard,
} from "../contracts";
import type { InternalVenueDashboard, UpcomingSlotSummary } from "../service";
import { batchedPublicIds, type PublicIdLookup, publicIds, requirePublicId } from "./public-resources";

export const projectVenues = async <T extends Venue>(items: T[], lookup: PublicIdLookup = publicIds): Promise<T[]> => {
  const venues = await lookup(
    "venues",
    items.map((item) => item.id),
  );
  return items.map((item) => ({ ...item, id: requirePublicId(venues, item.id) }));
};

export const projectOpeningRules = async <T extends OpeningRule>(items: T[], lookup: PublicIdLookup = publicIds): Promise<T[]> => {
  const [rules, venues] = await Promise.all([
    lookup(
      "openingRules",
      items.map((item) => item.id),
    ),
    lookup(
      "venues",
      items.map((item) => item.venueId),
    ),
  ]);
  return items.map((item) => ({ ...item, id: requirePublicId(rules, item.id), venueId: requirePublicId(venues, item.venueId) }));
};

export const projectOverrides = async <T extends DateOverride>(items: T[], lookup: PublicIdLookup = publicIds): Promise<T[]> => {
  const [overrides, venues] = await Promise.all([
    lookup(
      "overrides",
      items.map((item) => item.id),
    ),
    lookup(
      "venues",
      items.map((item) => item.venueId),
    ),
  ]);
  return items.map((item) => ({ ...item, id: requirePublicId(overrides, item.id), venueId: requirePublicId(venues, item.venueId) }));
};

export const projectTemplates = async <T extends ShiftTemplate>(items: T[], lookup: PublicIdLookup = publicIds): Promise<T[]> => {
  const [templates, venues] = await Promise.all([
    lookup(
      "templates",
      items.map((item) => item.id),
    ),
    lookup(
      "venues",
      items.map((item) => item.venueId),
    ),
  ]);
  return items.map((item) => ({ ...item, id: requirePublicId(templates, item.id), venueId: requirePublicId(venues, item.venueId) }));
};

export const projectAssignments = async <T extends ShiftAssignment>(items: T[], lookup: PublicIdLookup = publicIds): Promise<T[]> => {
  const [assignments, venues, templates] = await Promise.all([
    lookup(
      "assignments",
      items.map((item) => item.id),
    ),
    lookup(
      "venues",
      items.map((item) => item.venueId),
    ),
    lookup(
      "templates",
      items.map((item) => item.templateId),
    ),
  ]);
  return items.map((item) => ({
    ...item,
    id: requirePublicId(assignments, item.id),
    venueId: requirePublicId(venues, item.venueId),
    templateId: item.templateId ? requirePublicId(templates, item.templateId) : null,
  }));
};

export const projectSections = async <T extends PublicSection>(items: T[], lookup: PublicIdLookup = publicIds): Promise<T[]> => {
  const [sections, venues] = await Promise.all([
    lookup(
      "sections",
      items.map((item) => item.id),
    ),
    lookup(
      "venues",
      items.map((item) => item.venueId),
    ),
  ]);
  return items.map((item) => ({ ...item, id: requirePublicId(sections, item.id), venueId: requirePublicId(venues, item.venueId) }));
};

export const projectFeedbackEntries = async <T extends FeedbackEntry>(items: T[], lookup: PublicIdLookup = publicIds): Promise<T[]> => {
  const venues = await lookup(
    "venues",
    items.map((item) => item.venueId),
  );
  return items.map((item) => ({ ...item, venueId: requirePublicId(venues, item.venueId) }));
};

export const projectSlots = async (
  items: (UpcomingSlot & { key: string })[],
  lookup: PublicIdLookup = publicIds,
): Promise<UpcomingSlot[]> => {
  const [templates, assignments] = await Promise.all([
    projectTemplates(
      items.map((item) => item.template),
      lookup,
    ),
    projectAssignments(
      items.flatMap((item) => item.assignments),
      lookup,
    ),
  ]);
  let assignmentIndex = 0;
  return items.map((item, index) => {
    const template = templates[index]!;
    const slotAssignments = assignments.slice(assignmentIndex, assignmentIndex + item.assignments.length);
    assignmentIndex += item.assignments.length;
    const { key: _internalKey, ...publicItem } = item;
    return { ...publicItem, template, assignments: slotAssignments };
  });
};

export const projectSlotSummaries = async (items: UpcomingSlotSummary[]): Promise<UpcomingSlotSummary[]> => {
  const [templates, assignments] = await Promise.all([
    projectTemplates(items.map((item) => item.template)),
    publicIds(
      "assignments",
      items.map((item) => item.currentUserAssignmentId),
    ),
  ]);
  return items.map((item, index) => ({
    ...item,
    key: `${templates[index]!.id}:${item.date}`,
    template: templates[index]!,
    currentUserAssignmentId: item.currentUserAssignmentId ? requirePublicId(assignments, item.currentUserAssignmentId) : null,
  }));
};

export const projectPublicStatus = async (value: PublicStatus): Promise<PublicStatus> => {
  // the parts read their public ids together: one statement per table
  const lookup = batchedPublicIds();
  const [venues, openingRules, sections] = await Promise.all([
    projectVenues([value.venue], lookup),
    projectOpeningRules(value.openingRules, lookup),
    projectSections(value.sections, lookup),
  ]);
  return { ...value, venue: venues[0]!, openingRules, sections };
};

export const projectDashboard = async (value: InternalVenueDashboard): Promise<VenueDashboard> => {
  // a dashboard projects ten kinds of parts; they read their public ids together, one statement per table
  const lookup = batchedPublicIds();
  const [
    venues,
    openingRules,
    overrides,
    templates,
    slots,
    otherAssignments,
    outlookTemplates,
    assignments,
    myUpcomingShifts,
    sections,
    feedbackEntries,
  ] = await Promise.all([
    projectVenues([value.venue], lookup),
    projectOpeningRules(value.openingRules, lookup),
    projectOverrides(value.overrides, lookup),
    projectTemplates(value.templates, lookup),
    projectSlots(value.slots, lookup),
    projectAssignments(value.otherAssignments, lookup),
    lookup("templates", [value.outlook.nextGap?.templateId]),
    projectAssignments(value.assignments, lookup),
    projectAssignments(value.myUpcomingShifts, lookup),
    projectSections(value.sections, lookup),
    projectFeedbackEntries(value.feedbackEntries, lookup),
  ]);
  const nextGap = value.outlook.nextGap;
  return {
    ...value,
    venue: venues[0]!,
    openingRules,
    overrides,
    templates,
    slots,
    otherAssignments,
    outlook: {
      ...value.outlook,
      nextGap: nextGap ? { ...nextGap, templateId: requirePublicId(outlookTemplates, nextGap.templateId) } : null,
    },
    assignments,
    myUpcomingShifts,
    sections,
    feedbackEntries,
  };
};
