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
import { publicIds, requirePublicId } from "./public-resources";

export const projectVenues = async <T extends Venue>(items: T[]): Promise<T[]> => {
  const venues = await publicIds(
    "venues",
    items.map((item) => item.id),
  );
  return items.map((item) => ({ ...item, id: requirePublicId(venues, item.id) }));
};

export const projectOpeningRules = async <T extends OpeningRule>(items: T[]): Promise<T[]> => {
  const [rules, venues] = await Promise.all([
    publicIds(
      "openingRules",
      items.map((item) => item.id),
    ),
    publicIds(
      "venues",
      items.map((item) => item.venueId),
    ),
  ]);
  return items.map((item) => ({ ...item, id: requirePublicId(rules, item.id), venueId: requirePublicId(venues, item.venueId) }));
};

export const projectOverrides = async <T extends DateOverride>(items: T[]): Promise<T[]> => {
  const [overrides, venues] = await Promise.all([
    publicIds(
      "overrides",
      items.map((item) => item.id),
    ),
    publicIds(
      "venues",
      items.map((item) => item.venueId),
    ),
  ]);
  return items.map((item) => ({ ...item, id: requirePublicId(overrides, item.id), venueId: requirePublicId(venues, item.venueId) }));
};

export const projectTemplates = async <T extends ShiftTemplate>(items: T[]): Promise<T[]> => {
  const [templates, venues] = await Promise.all([
    publicIds(
      "templates",
      items.map((item) => item.id),
    ),
    publicIds(
      "venues",
      items.map((item) => item.venueId),
    ),
  ]);
  return items.map((item) => ({ ...item, id: requirePublicId(templates, item.id), venueId: requirePublicId(venues, item.venueId) }));
};

export const projectAssignments = async <T extends ShiftAssignment>(items: T[]): Promise<T[]> => {
  const [assignments, venues, templates] = await Promise.all([
    publicIds(
      "assignments",
      items.map((item) => item.id),
    ),
    publicIds(
      "venues",
      items.map((item) => item.venueId),
    ),
    publicIds(
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

export const projectSections = async <T extends PublicSection>(items: T[]): Promise<T[]> => {
  const [sections, venues] = await Promise.all([
    publicIds(
      "sections",
      items.map((item) => item.id),
    ),
    publicIds(
      "venues",
      items.map((item) => item.venueId),
    ),
  ]);
  return items.map((item) => ({ ...item, id: requirePublicId(sections, item.id), venueId: requirePublicId(venues, item.venueId) }));
};

export const projectFeedbackEntries = async <T extends FeedbackEntry>(items: T[]): Promise<T[]> => {
  const venues = await publicIds(
    "venues",
    items.map((item) => item.venueId),
  );
  return items.map((item) => ({ ...item, venueId: requirePublicId(venues, item.venueId) }));
};

export const projectSlots = async (items: (UpcomingSlot & { key: string })[]): Promise<UpcomingSlot[]> => {
  const [templates, assignments] = await Promise.all([
    projectTemplates(items.map((item) => item.template)),
    projectAssignments(items.flatMap((item) => item.assignments)),
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
  const [venues, openingRules, sections] = await Promise.all([
    projectVenues([value.venue]),
    projectOpeningRules(value.openingRules),
    projectSections(value.sections),
  ]);
  return { ...value, venue: venues[0]!, openingRules, sections };
};

export const projectDashboard = async (value: InternalVenueDashboard): Promise<VenueDashboard> => {
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
    projectVenues([value.venue]),
    projectOpeningRules(value.openingRules),
    projectOverrides(value.overrides),
    projectTemplates(value.templates),
    projectSlots(value.slots),
    projectAssignments(value.otherAssignments),
    publicIds("templates", [value.outlook.nextGap?.templateId]),
    projectAssignments(value.assignments),
    projectAssignments(value.myUpcomingShifts),
    projectSections(value.sections),
    projectFeedbackEntries(value.feedbackEntries),
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
