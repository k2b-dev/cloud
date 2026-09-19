import { createHash } from "node:crypto";
import type { ListingOptions } from "@k2b/filegate";
import { z } from "zod";
import { type BrowseOptions, BrowseOptionsSchema } from "../contracts";
import { FilesError } from "./errors";

const cursorSchema = z.object({ version: z.literal(1), key: z.string(), phase: z.enum(["all", "files", "directories"]), after: z.string().optional() });
export type BrowseInput = Partial<BrowseOptions> & { after?: string };

/** At most two reads join the directory/file boundary. Filegate cursors bind their limit:
 * keep it fixed and allow at most 2 * pageSize - 1 entries on this one boundary page. */
export async function browsePage<T>(
  input: BrowseInput,
  scope: string,
  fetchPage: (options: Pick<ListingOptions, "sort" | "order" | "type" | "after" | "limit">) => Promise<{ items: T[]; next?: string | null }>,
  pageSize = 50,
): Promise<{ items: T[]; next: string | null }> {
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000) throw new FilesError("invalid_input");
  const options = BrowseOptionsSchema.parse(input);
  const key = createHash("sha256").update(JSON.stringify([scope, options.sort, options.order, options.type, options.groupFolders, pageSize])).digest("hex");
  const grouped = options.type === "all" && options.groupFolders;
  let phase = grouped ? "directories" as const : options.type;
  let after: string | undefined;
  if (input.after) {
    try {
      const cursor = cursorSchema.parse(JSON.parse(Buffer.from(input.after, "base64url").toString("utf8")));
      if (cursor.key !== key || (grouped ? cursor.phase === "all" : cursor.phase !== options.type)) throw new Error("query changed");
      phase = cursor.phase;
      after = cursor.after;
    } catch { throw new FilesError("cursor_invalid", 409); }
  }
  let page = await fetchPage({ sort: options.sort, order: options.order, type: phase, after, limit: pageSize });
  if (grouped && phase === "directories" && !page.next && page.items.length < pageSize) {
    phase = "files";
    const files = await fetchPage({ sort: options.sort, order: options.order, type: phase, limit: pageSize });
    page = { items: [...page.items, ...files.items], next: files.next };
  }
  const nextPhase = page.next ? phase : grouped && phase === "directories" ? "files" : null;
  return {
    items: page.items,
    next: nextPhase ? Buffer.from(JSON.stringify({ version: 1, key, phase: nextPhase, ...(page.next ? { after: page.next } : {}) })).toString("base64url") : null,
  };
}
