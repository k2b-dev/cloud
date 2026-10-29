import { arg, type CloudCliContext, command, defineCliCommands, flag, printStructured } from "@k2b/cloud/cli";
import { chatMessages } from "./messages";
import { FollowingSchema, NotificationsSchema, NotificationUpdateSchema, ShortIdSchema } from "./service/contracts";

const chatCommands = (locale?: string) => {
  const t = chatMessages.resolve(locale ? [locale] : []).t;
  const chat = { chat: arg.required({ description: t.chatIdArgument }) };
  return defineCliCommands({
    name: "chat",
    summary: t.chatCliSummary,
    commands: [
      command("notify", {
        summary: t.notifySummary,
        args: { ...chat, level: arg.optional({ description: t.notifyLevelArgument }) },
        flags: { for: flag.enum(["1h", "8h", "1w"] as const, { description: t.notifyForFlag }) },
        async run({ ctx, args, flags }) {
          if ((flags.for && args.level !== "off") || (args.level && !["all", "mentions", "off", "default"].includes(args.level)))
            throw new Error(t.notifyInvalidArguments);
          const path = `/api/chat/conversations/${ShortIdSchema.parse(args.chat)}/notifications`;
          const input = args.level
            ? NotificationUpdateSchema.parse(args.level === "off" ? { level: "none", for: flags.for ?? "forever" } : { level: args.level })
            : undefined;
          const state = NotificationsSchema.parse(
            await ctx.readJson(
              await ctx.fetch(
                path,
                input ? { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(input) } : undefined,
              ),
            ),
          );
          if (printStructured(ctx, state)) return;
          const label = { all: t.notificationsAll, mentions: t.notificationsMentions, none: t.notificationsNone };
          ctx.print(
            `${t.notificationsLabel}: ${label[state.level]}${state.choice === null ? ` (${t.notificationsDefault})` : ""}${state.until ? ` · ${state.until}` : ""}`,
          );
        },
      }),
      ...([true, false] as const).map((following) =>
        command(following ? "follow" : "unfollow", {
          summary: following ? t.followSummary : t.unfollowSummary,
          args: { ...chat, thread: arg.required({ description: t.threadIdArgument }) },
          async run({ ctx, args }) {
            const result = FollowingSchema.parse(
              await ctx.readJson(
                await ctx.fetch(
                  `/api/chat/conversations/${ShortIdSchema.parse(args.chat)}/threads/${ShortIdSchema.parse(args.thread)}/follow`,
                  { method: following ? "PUT" : "DELETE" },
                ),
              ),
            );
            if (!printStructured(ctx, result)) ctx.print(result.following ? t.followingLabel : t.notFollowingLabel);
          },
        }),
      ),
    ],
  });
};
const chat = chatCommands();
export default {
  ...chat,
  help: (locale?: string) => chatCommands(locale).help!(),
  run: (ctx: CloudCliContext) => chatCommands(ctx.options.locale).run(ctx),
};
