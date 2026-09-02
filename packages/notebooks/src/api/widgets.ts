import { dates } from "@k2b/stdlib";
import type { WidgetListItem, WidgetResponse } from "@valentinkolb/cloud/contracts";
import { type AuthContext, auth, getDateConfig, getLocale, getUserBackedActor } from "@valentinkolb/cloud/server";
import { type Context, Hono } from "hono";
import { notebooksService } from "../service";
import { notebookApiMessages } from "./messages";

const RECENT_LIMIT = 5;

/**
 * Widget endpoints for the dashboard. Authenticated only — anonymous
 * requests get 204 silent-skip rather than 401. `requireRole("*")` loads
 * the session without enforcing auth so we can answer 204 ourselves.
 *
 * The list block uses each note's parent-notebook icon so the widget
 * visually echoes the user's notebook palette.
 */
export const recentNotesWidgetHandler = async (c: Context<AuthContext>) => {
  const { t } = notebookApiMessages.resolve([getLocale(c)]);
  const user = getUserBackedActor(c);
  // Anonymous dashboard probes should silently skip this widget.
  if (!user) return c.body(null, 204);

  const notes = await notebooksService.note.recentForUser({
    userId: user.id,
    limit: RECENT_LIMIT,
  });

  if (notes.length === 0) {
    const body: WidgetResponse = {
      title: t.recentNotes,
      icon: "ti ti-notebook",
      href: "/app/notebooks",
      blocks: [
        {
          kind: "hero",
          icon: "ti ti-notebook",
          tone: "blue",
          title: t.noNotes,
          subtitle: t.noNotesDescription,
        },
      ],
    };
    return c.json(body);
  }

  // `notebookIcon` is stored as the bare Tabler name (e.g. `ti-notebook`)
  // — see `ICON_OPTIONS` in `cloud/shared/icons.ts`. The dashboard
  // renders the icon as `<i class={item.icon}>`, so we have to prepend
  // the `ti` family class ourselves; otherwise the font isn't applied
  // and the icon renders as a generic glyph.
  const items: WidgetListItem[] = notes.map((n) => ({
    icon: n.notebookIcon ? `ti ${n.notebookIcon}` : "ti ti-file-text",
    label: n.title || t.untitled,
    sub: n.notebookName,
    meta: dates.formatDateRelative(new Date(n.updatedAt), getDateConfig(c)),
    href: `/app/notebooks/${n.notebookShortId}/notes/${n.shortId}`,
  }));

  const body: WidgetResponse = {
    title: t.recentNotes,
    icon: "ti ti-notebook",
    href: "/app/notebooks",
    blocks: [{ kind: "list", items, grow: true }],
  };
  return c.json(body);
};

const app = new Hono<AuthContext>().use(auth.requireRole("*")).get("/recent", recentNotesWidgetHandler);

export default app;
