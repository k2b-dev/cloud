import { arg, command, confirmFlag, flag } from "@valentinkolb/cloud/cli";
import { z } from "zod";
import { requirePublicId } from "./resources";
import { jsonRequest, printCliStructured, queryString, readApi } from "./runtime";

export const recordEventCommands = [
  command("record-events failures", {
    summary: "List 100 retained delivery failures as a platform administrator",
    args: { base: arg.required({ description: "Base public ID" }) },
    flags: { offset: flag.int({ min: 0, default: 0, description: "nextOffset returned by the previous page" }) },
    async run({ ctx, args, flags }) {
      const result = await readApi<unknown>(
        ctx,
        `/admin/bases/${requirePublicId(args.base, "Base")}/record-event-failures${queryString(flags)}`,
      );
      if (!printCliStructured(ctx, result)) ctx.json(result);
    },
  }),
  command("record-events replay", {
    summary: "Replay one retained stopped delivery as a platform administrator",
    description:
      "Acceptance does not mean processing has completed. The original retained event is used; retrying events cannot be replayed.",
    args: {
      base: arg.required({ description: "Base public ID" }),
      failure: arg.required({ description: "Exact operational failure UUID returned by record-events failures" }),
    },
    flags: { yes: confirmFlag("Replay the retained event") },
    async run({ ctx, args, flags }) {
      if (!flags.yes) throw new Error("Pass --yes to replay the retained event.");
      const failureId = z.uuid().parse(args.failure);
      const result = await readApi<unknown>(
        ctx,
        `/admin/bases/${requirePublicId(args.base, "Base")}/record-event-failures/${failureId}/replay`,
        jsonRequest("POST", {}),
      );
      if (!printCliStructured(ctx, result)) ctx.json(result);
    },
  }),
] as const;
