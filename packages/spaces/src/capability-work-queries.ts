import { createHash } from "node:crypto";
import type { DateContext } from "@k2b/stdlib";
import { CAPABILITY_MAX_RESULT_BYTES, capabilityPage } from "@valentinkolb/cloud/contracts";
import type { AccessSubject } from "@valentinkolb/cloud/server";
import type { z } from "zod";
import {
  decodeAgendaCursor,
  decodeWorkCursor,
  type EventAgendaInputSchema,
  encodeAgendaCursor,
  encodeWorkCursor,
  type TaskFocusInputSchema,
} from "./capability-work-contracts";
import { buildSpaceItemHref } from "./routes";
import { spacesService } from "./service";
import { spacesPublicResources } from "./service/public-resources";

type WorkContext = { subject: AccessSubject; boundSpaceId?: string | null; spaceId?: string; dateConfig?: DateContext };
const page = (offset: number, count: number, limit: number) => capabilityPage(count > limit ? encodeWorkCursor(offset + limit) : undefined);

export const boundedWorkPage = <T>(data: T[], offset: number, remaining: number) => {
  const result = { data, page: page(offset, remaining, data.length) };
  while (Buffer.byteLength(JSON.stringify(result), "utf8") > CAPABILITY_MAX_RESULT_BYTES) {
    if (result.data.length <= 1) throw new Error("A work item exceeds the capability response budget");
    result.data = result.data.slice(0, -1);
    result.page = page(offset, remaining, result.data.length);
  }
  return result;
};

export const runTaskFocus = async (input: z.infer<typeof TaskFocusInputSchema>, context: WorkContext) => {
  const offset = decodeWorkCursor(input.cursor);
  const rows = await spacesService.item.searchAcross({
    ...context,
    query: input.query,
    kinds: "task",
    status: "open",
    assignedTo: input.assignedTo,
    activity: input.activity,
    deadlineFilter: input.deadlineFilter,
    priority: input.priority,
    blocked: input.blocked,
    offset,
    limit: input.limit + 1,
  });
  const items = await spacesPublicResources.projectItems(rows.slice(0, input.limit).map((row) => row.item));
  return boundedWorkPage(
    items.map((item, index) => ({
      ref: { type: "spaces.item" as const, id: item.id },
      title: item.title.slice(0, 500),
      spaceId: item.spaceId,
      spaceName: rows[index]!.space.name.slice(0, 200),
      columnId: item.columnId,
      columnName: rows[index]!.columnName?.slice(0, 200) ?? null,
      deadline: item.deadline,
      priority: item.priority,
      activeBlockerCount: item.activeBlockerCount ?? 0,
      href: buildSpaceItemHref(item.spaceId, item.id),
    })),
    offset,
    rows.length,
  );
};

export const runEventAgenda = async (input: z.infer<typeof EventAgendaInputSchema>, context: WorkContext) => {
  const scope = createHash("sha256")
    .update(
      JSON.stringify({
        from: input.from,
        to: input.to,
        assignedTo: input.assignedTo,
        spaceId: context.spaceId,
        boundSpaceId: context.boundSpaceId,
        subject: context.subject,
        dateConfig: context.dateConfig,
      }),
    )
    .digest("hex")
    .slice(0, 32);
  const cursor = decodeAgendaCursor(input.cursor, scope);
  const offset = cursor.offset;
  const sourcePage = await spacesService.item.calendar.listSourcePage({
    ...context,
    from: input.from,
    to: input.to,
    assignedTo: input.assignedTo,
    afterRootId: cursor.root,
  });
  const rows = sourcePage.items;
  const items = await spacesPublicResources.projectCalendarItems(rows.slice(offset, offset + input.limit));
  const data = items.map((item) => {
    const id = item.id.split(":", 1)[0]!;
    return {
      ref: { type: "spaces.item" as const, id },
      title: item.title.slice(0, 500),
      spaceId: item.spaceId,
      spaceName: item.spaceName.slice(0, 200),
      startsAt: item.startsAt!,
      endsAt: item.endsAt!,
      allDay: item.allDay,
      location: item.location?.slice(0, 500) ?? null,
      recurrenceId: item.recurrenceId,
      seriesId: item.recurringEventId,
      href: `${buildSpaceItemHref(item.spaceId, id)}${item.recurrenceId ? `&occurrence=${encodeURIComponent(item.recurrenceId)}` : ""}`,
    };
  });
  const nextPage = (count: number) =>
    capabilityPage(
      offset + count < rows.length
        ? encodeAgendaCursor({ ...cursor, offset: offset + count })
        : sourcePage.nextRootId
          ? encodeAgendaCursor({ scope, root: sourcePage.nextRootId, offset: 0 })
          : undefined,
    );
  const result = { data, page: nextPage(data.length) };
  while (Buffer.byteLength(JSON.stringify(result), "utf8") > CAPABILITY_MAX_RESULT_BYTES) {
    if (result.data.length <= 1) throw new Error("A calendar occurrence exceeds the capability response budget");
    result.data = result.data.slice(0, -1);
    result.page = nextPage(result.data.length);
  }
  return result;
};
