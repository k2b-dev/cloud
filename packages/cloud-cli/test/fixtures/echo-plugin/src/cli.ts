import { command, defineCliCommands, printStructured } from "@k2b/cloud/cli";

/** Test plugin: echoes what the host CLI context sends to the Cloud server. */
export default defineCliCommands({
  name: "echo",
  summary: "Echo the host CLI context (test plugin).",
  commands: [
    command("whoami", {
      summary: "Show what the server received",
      async run({ ctx }) {
        const received = await ctx.readJson<{ authorization: string; locale: string }>(await ctx.fetch("/api/echo"));
        const result = { ...received, profile: ctx.options.profile, output: ctx.options.output };
        if (printStructured(ctx, result)) return;
        ctx.print(`echo ${result.authorization} ${result.locale}`);
      },
    }),
  ],
});
