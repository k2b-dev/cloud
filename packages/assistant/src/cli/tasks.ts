import type { ChatTaskExportPage } from "@k2b/cloud/ai";
import { command, flag } from "@k2b/cloud/cli";
import { readApi } from "./shared";

/** Export frozen definitions only; routine execution is retired. */
export const assistantTaskCommands = [
  command("tasks export", {
    summary: "Export all routine definitions as versioned JSON (grants no access)",
    flags: { all: flag.boolean({ description: "Export every person's routines; requires Cloud administration" }) },
    async run({ ctx, flags }) {
      const endpoint = flags.all ? "/admin/tasks/export" : "/tasks/export";
      let after: string | null = null;
      let first = true;
      let started = false;
      do {
        const page: ChatTaskExportPage = await readApi(ctx, `${endpoint}${after ? `?after=${after}` : ""}`);
        if (ctx.options.output === "jsonl") ctx.jsonLine(page);
        else {
          if (!started) {
            const { items: _items, nextCursor: _cursor, ...metadata } = page;
            await ctx.write(`${JSON.stringify(metadata).slice(0, -1)},"items":[`);
            started = true;
          }
          for (const item of page.items) {
            await ctx.write(`${first ? "" : ","}${JSON.stringify(item)}`);
            first = false;
          }
        }
        if (page.nextCursor !== null && page.nextCursor === after) throw new Error("Export cursor did not advance. Retry the export.");
        after = page.nextCursor;
      } while (after !== null);
      if (ctx.options.output !== "jsonl") await ctx.write('],"nextCursor":null}\n');
    },
  }),
];
