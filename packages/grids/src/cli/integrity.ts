import { command, flag } from "@k2b/cloud/cli";
import { JSON_BODY_INPUT, jsonRequest, printCliStructured, readJsonInput } from "./runtime";

const operations = [
  ["records atomic", "record.atomic", "Change Records atomically after current-state checks"],
  ["records correction-draft", "record.correction-draft", "Create a linked correction or cancellation draft"],
  ["records close", "record.close", "Close a Record under its pinned finalization policy"],
  ["documents capture", "document.capture", "Freeze complete GQL data for document issuance"],
  ["documents issue", "document.issue", "Issue a document from an immutable data capture"],
  ["documents confirm", "document.confirm", "Confirm the exact financial preview and issue its document"],
] as const;

export const integrityCommands = operations.map(([name, action, summary]) =>
  command(name, {
    summary,
    description:
      "Uses the capability contract and its current permissions and approval policy. Read cld capabilities review grids <action> before an asking operation.",
    flags: {
      input: JSON_BODY_INPUT,
      "idempotency-key": flag.string({ required: true, description: "Stable key for retries of this exact operation" }),
    },
    async run({ ctx, flags }) {
      const key = flags["idempotency-key"];
      if (!key) throw new Error("Missing idempotency key.");
      const input = await readJsonInput<unknown>(flags.input, "capability input");
      const result = await ctx.readJson<unknown>(
        await ctx.fetch(`/api/capabilities/v1/actions/grids/${action}`, jsonRequest("POST", { input }, { "idempotency-key": key })),
      );
      if (!printCliStructured(ctx, result)) ctx.json(result);
    },
  }),
);
