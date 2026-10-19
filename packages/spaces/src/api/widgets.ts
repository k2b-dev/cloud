import type { WidgetBlock, WidgetListItem, WidgetResponse, WidgetTone } from "@k2b/cloud/contracts";
import { type AuthContext, auth, getDateConfig, getLocale, getUserBackedActor, getWidgetRequest } from "@k2b/cloud/server";
import { type DateContext, dates } from "@k2b/stdlib";
import { type Context, Hono } from "hono";
import { deadlineDayKey, formatDeadline } from "@/presentation/deadline";
import { buildSpaceItemHref } from "../routes";
import { spacesService } from "../service";
import { type SpacesMessages, spacesMessages } from "../service/messages";
import { projectItemReferences, resolvePublicId } from "../service/public-resources";

/**
 * Spaces dashboard widget — today's events + next-up todos for the user,
 * across every accessible space. Composition decided server-side based on
 * what the user actually has:
 *
 *   - 0 todos AND 0 events  → 204 silent skip
 *   - has events            → list block "Today" first
 *   - has open todos        → compact list of the next deadlines
 *
 * Priority maps to coloured icon for at-a-glance triage. Medium shows the first
 * two rows, large up to six.
 */
type Priority = "low" | "medium" | "high" | "urgent" | null;

const priorityIcon: Record<Exclude<Priority, null>, { icon: string; tone: WidgetTone }> = {
  urgent: { icon: "ti ti-flame", tone: "red" },
  high: { icon: "ti ti-flag-3", tone: "amber" },
  medium: { icon: "ti ti-flag-3", tone: "blue" },
  low: { icon: "ti ti-flag-3", tone: "zinc" },
};

const todoIcon = (priority: Priority): { icon: string; iconTone?: WidgetTone } => {
  if (priority && priorityIcon[priority]) {
    return { icon: priorityIcon[priority].icon, iconTone: priorityIcon[priority].tone };
  }
  return { icon: "ti ti-circle" };
};

const formatRelativeDeadline = (deadline: string | null, t: SpacesMessages, dateConfig?: DateContext): string | undefined => {
  if (!deadline) return undefined;
  if (deadlineDayKey(deadline, dateConfig) < dates.formatDateKey(dates.today(dateConfig), dateConfig)) return t.widgetOverdue;
  return formatDeadline(deadline, dateConfig);
};

const formatTimeRange = (startsAt: string | null, endsAt: string | null, t: SpacesMessages, dateConfig?: DateContext): string => {
  const fmt = (iso: string) => dates.formatTime(iso, dateConfig);
  if (startsAt && endsAt) return `${fmt(startsAt)}–${fmt(endsAt)}`;
  if (startsAt) return fmt(startsAt);
  return t.widgetToday;
};

/** Return today's summary, authorizing a chosen Space on every invocation. */
export const spacesTodayWidgetHandler = async (c: Context<AuthContext>) => {
  const user = getUserBackedActor(c);
  // The summary needs a user-backed actor; a selected Space also needs current read access.
  if (!user) return c.body(null, 403);

  const locale = getLocale(c);
  const t = spacesMessages(locale);
  const dateConfig = getDateConfig(c);
  const request = getWidgetRequest(c);
  const selected = request.settings.space;
  let spaceId: string | undefined;
  let title = t.widgetTitle;
  let href = "/app/spaces";
  if (typeof selected === "object") {
    const resolved = await resolvePublicId("spaces", selected.id);
    if (
      !resolved ||
      !(await spacesService.space.permission.canAccess({ spaceId: resolved, subject: c.get("accessSubject"), requiredLevel: "read" }))
    )
      return c.body(null, 403);
    const space = await spacesService.space.get({ id: resolved });
    if (!space) return c.body(null, 403);
    spaceId = resolved;
    title = t.widgetSpaceTitle({ space: space.name });
    href = `/app/spaces/${selected.id}`;
  }
  const rows = request.size === "large" ? 6 : 2;
  const internalSnapshot = await spacesService.item.dashboardSnapshot({
    userId: user.id,
    spaceId,
    todoLimit: rows,
    dateConfig,
  });
  const [events, todos] = await Promise.all([
    projectItemReferences(internalSnapshot.events),
    projectItemReferences(internalSnapshot.todos),
  ]);
  const snap = { ...internalSnapshot, events, todos };

  if (snap.openTodoCount === 0 && snap.events.length === 0) {
    const body: WidgetResponse = {
      title,
      icon: "ti ti-checklist",
      href,
      blocks: [
        {
          kind: "hero",
          icon: "ti ti-circle-check",
          tone: "emerald",
          title: t.widgetEmptyTitle,
          subtitle: t.widgetEmptySubtitle,
        },
      ],
    };
    return c.json(body);
  }

  // Combine events and todos into a concise briefing list.
  // Events first (they have a clock + time meta), then deadlines.
  const items: WidgetListItem[] = [
    ...snap.events.map(
      (e): WidgetListItem => ({
        icon: "ti ti-clock",
        iconTone: "blue",
        label: e.title,
        sub: e.spaceName,
        meta: formatTimeRange(e.startsAt, e.endsAt, t, dateConfig),
        href: buildSpaceItemHref(e.spaceId, e.id),
      }),
    ),
    ...snap.todos.map((todo): WidgetListItem => {
      const ic = todoIcon(todo.priority);
      return {
        icon: ic.icon,
        iconTone: ic.iconTone,
        label: todo.title,
        sub: todo.spaceName,
        meta: formatRelativeDeadline(todo.deadline, t, dateConfig),
        href: buildSpaceItemHref(todo.spaceId, todo.id),
      };
    }),
  ];
  const blocks: WidgetBlock[] = [{ kind: "list", items: items.slice(0, rows) }];

  const body: WidgetResponse = {
    title,
    icon: "ti ti-checklist",
    href,
    meta: [
      snap.events.length > 0 ? t.widgetTodayCount({ count: snap.events.length }) : null,
      snap.openTodoCount > 0 ? t.widgetOpenCount({ count: snap.openTodoCount }) : null,
      snap.urgentCount > 0 ? t.widgetUrgentCount({ count: snap.urgentCount }) : null,
    ]
      .filter(Boolean)
      .join(" · "),
    blocks,
  };
  return c.json(body);
};

const app = new Hono<AuthContext>().use(auth.requireRole("*")).get("/today", spacesTodayWidgetHandler);

export default app;
