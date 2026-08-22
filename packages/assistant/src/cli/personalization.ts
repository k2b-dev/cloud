import type { AiMemory, AiUserPrefs } from "@valentinkolb/cloud/ai";
import { arg, command, confirmFlag, flag, readCliInput } from "@valentinkolb/cloud/cli";
import { jsonRequest, printRows, printValue, queryString, readApi, requireConfirmation } from "./shared";

type PersonalizationSettings = Pick<AiUserPrefs, "memoryEnabled" | "memoryLearningEnabled">;

const settingsView = (prefs: AiUserPrefs): PersonalizationSettings => ({
  memoryEnabled: prefs.memoryEnabled,
  memoryLearningEnabled: prefs.memoryLearningEnabled,
});

const printSettings = (ctx: Parameters<typeof printValue>[0], prefs: AiUserPrefs): void => {
  const settings = settingsView(prefs);
  printValue(
    ctx,
    settings,
    [`Personalization\t${settings.memoryEnabled ? "on" : "off"}`, `Learning\t${settings.memoryLearningEnabled ? "on" : "off"}`].join("\n"),
  );
};

const memoryPath = (memoryId: string): string => `/memories/${encodeURIComponent(memoryId)}`;

export const assistantPersonalizationCommands = [
  command("personalization list", {
    summary: "List or search saved personalization",
    flags: {
      search: flag.string({ aliases: ["q"], description: "Search memory content" }),
      limit: flag.int({ default: 20, min: 1, max: 50 }),
    },
    async run({ ctx, flags }) {
      const memories = await readApi<AiMemory[]>(ctx, `/memories${queryString({ q: flags.search, limit: flags.limit })}`);
      printRows(
        ctx,
        memories,
        memories.map((memory) => ({
          id: memory.shortId,
          kind: memory.kind,
          priority: memory.priority,
          source: memory.source,
          updated: memory.updatedAt,
          content: memory.content,
        })),
        [{ key: "id" }, { key: "kind" }, { key: "priority" }, { key: "source" }, { key: "updated" }, { key: "content" }],
      );
    },
  }),
  command("personalization add", {
    summary: "Add a pinned personal fact or preference",
    args: { kind: arg.required({ valueLabel: "fact-or-preference" }) },
    flags: { content: flag.input({ required: true, description: "Content text or --content-file" }) },
    async run({ ctx, args, flags }) {
      if (args.kind !== "fact" && args.kind !== "preference") throw new Error('Kind must be "fact" or "preference".');
      const content = await readCliInput(flags.content, { label: "personalization content", required: true, trimFinalNewline: true });
      const memory = await readApi<AiMemory>(ctx, "/memories", jsonRequest("POST", { kind: args.kind, content }));
      printValue(ctx, memory, `${memory.shortId}\t${memory.content}`);
    },
  }),
  command("personalization update", {
    summary: "Update a personal fact or preference",
    args: { memory: arg.required({ valueLabel: "memory-id" }) },
    flags: {
      kind: flag.enum(["fact", "preference"] as const),
      content: flag.input({ description: "Content text or --content-file" }),
    },
    async run({ ctx, args, flags }) {
      const content = await readCliInput(flags.content, { label: "personalization content", trimFinalNewline: true });
      const changes = { ...(flags.kind ? { kind: flags.kind } : {}), ...(content !== undefined ? { content } : {}) };
      if (!Object.keys(changes).length) throw new Error("Supply --kind or --content.");
      const memory = await readApi<AiMemory>(ctx, memoryPath(args.memory), jsonRequest("PATCH", changes));
      printValue(ctx, memory, `Updated ${memory.shortId}.`);
    },
  }),
  ...(["pin", "unpin"] as const).map((action) =>
    command(`personalization ${action}`, {
      summary: `${action === "pin" ? "Pin" : "Unpin"} a personalization entry`,
      args: { memory: arg.required({ valueLabel: "memory-id" }) },
      async run({ ctx, args }) {
        const memory = await readApi<AiMemory>(
          ctx,
          memoryPath(args.memory),
          jsonRequest("PATCH", { priority: action === "pin" ? "pinned" : "normal" }),
        );
        printValue(ctx, memory, `${action === "pin" ? "Pinned" : "Unpinned"} ${memory.shortId}.`);
      },
    }),
  ),
  command("personalization forget", {
    summary: "Forget a personalization entry",
    args: { memory: arg.required({ valueLabel: "memory-id" }) },
    flags: { yes: confirmFlag("Confirm forgetting this personalization entry") },
    async run({ ctx, args, flags }) {
      requireConfirmation(flags.yes, "Forgetting personalization");
      const result = await readApi<{ deleted: true }>(ctx, memoryPath(args.memory), { method: "DELETE" });
      printValue(ctx, result, `Forgot ${args.memory}.`);
    },
  }),
  command("personalization status", {
    summary: "Show personalization and learning status",
    async run({ ctx }) {
      printSettings(ctx, await readApi<AiUserPrefs>(ctx, "/prefs"));
    },
  }),
  command("personalization configure", {
    summary: "Enable or disable personalization use and learning",
    flags: {
      use: flag.enum(["on", "off"] as const, { description: "Use saved facts, preferences, and workflow defaults in Assistant chats" }),
      learning: flag.enum(["on", "off"] as const, { description: "Learn durable personalization from private chats" }),
    },
    async run({ ctx, flags }) {
      if (!flags.use && !flags.learning) throw new Error("Supply --use or --learning.");
      const prefs = await readApi<AiUserPrefs>(
        ctx,
        "/prefs",
        jsonRequest("PUT", {
          ...(flags.use ? { memoryEnabled: flags.use === "on" } : {}),
          ...(flags.learning ? { memoryLearningEnabled: flags.learning === "on" } : {}),
        }),
      );
      printSettings(ctx, prefs);
    },
  }),
] as const;
