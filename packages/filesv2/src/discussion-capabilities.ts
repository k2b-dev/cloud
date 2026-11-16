import { createHash } from "node:crypto";
import { DiscussionContainersDataSchema, DiscussionContainersInputSchema } from "@k2b/cloud/contracts";
import { FilegateError } from "@k2b/filegate";
import { err, fail, ok } from "@k2b/stdlib";
import { z } from "zod";
import { apiError } from "./api/api-error";
import { errorMessage } from "./api/messages";
import { capabilityCall } from "./files-call";
import { FilesError, filesService } from "./service";

const CursorSchema = z
  .object({
    v: z.literal(1),
    base: z.string().min(1).max(512),
    after: z.string().max(2048).optional(),
    offset: z.number().int().min(0).max(100),
    query: z.string().length(64),
  })
  .strict();

export const discussionQueries = {
  "folder.containers": {
    title: "List discussion folders",
    description: "List readable storage roots and folders. Follow the opaque cursor, including after an empty page.",
    input: DiscussionContainersInputSchema,
    data: DiscussionContainersDataSchema,
    openWorld: false,
    run: async (input: z.output<typeof DiscussionContainersInputSchema>, context: Parameters<typeof capabilityCall>[0]) => {
      let cursor: z.output<typeof CursorSchema> | undefined;
      const query = (input.query ?? "").trim().toLowerCase();
      const queryKey = createHash("sha256").update(query).digest("hex");
      if (input.cursor) {
        try {
          cursor = CursorSchema.parse(JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")));
          if (cursor.query !== queryKey) throw new Error("Query changed");
        } catch {
          return fail(err.badInput(errorMessage("invalid_cursor", context.locale)));
        }
      }
      try {
        const call = capabilityCall(context);
        const bases = (await filesService.baseNames(call)).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        const base = cursor ? bases.find((base) => base.id === cursor.base) : bases[0];
        if (!base) {
          if (cursor) return fail(err.badInput(errorMessage("invalid_cursor", context.locale)));
          return ok({ data: { items: [], next: null } });
        }
        context.signal?.throwIfAborted();
        const page = await filesService.discussionFolderPage(call, { baseId: base.id, after: cursor?.after, signal: context.signal });
        const items = [];
        let offset = cursor?.offset ?? 0;
        if (offset > page.items.length) return fail(err.badInput(errorMessage("invalid_cursor", context.locale)));
        for (; offset < page.items.length; offset++) {
          const item = page.items[offset]!;
          if (!query || item.title.toLowerCase().includes(query)) items.push(item);
          if (items.length === input.limit) {
            offset++;
            break;
          }
        }
        const nextBase = bases.find((candidate) => candidate.id > base.id);
        const position =
          offset < page.items.length
            ? { base: base.id, after: cursor?.after, offset }
            : page.next
              ? { base: base.id, after: page.next, offset: 0 }
              : nextBase
                ? { base: nextBase.id, offset: 0 }
                : null;
        const next = position ? Buffer.from(JSON.stringify({ v: 1, ...position, query: queryKey })).toString("base64url") : null;
        if (next && next.length > 2048) throw new FilesError("unavailable", 503);
        return ok({ data: { items, next } });
      } catch (error) {
        if (!(error instanceof FilesError || error instanceof FilegateError)) throw error;
        const { code, status } = apiError(error);
        throw { code, status, message: errorMessage(code, context.locale) };
      }
    },
  },
};
