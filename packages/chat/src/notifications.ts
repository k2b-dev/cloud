import { notification } from "@k2b/cloud";
import { i18n } from "@k2b/stdlib";
import { z } from "zod";

const truncate = (text: string, budget: number) => {
  let result = "";
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)) {
    if (result.length + segment.length > budget) break;
    result += segment;
  }
  return result;
};
const copy = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      mention: ({ name }: { name: string }) => `${name} mentioned you`,
      reply: ({ name }: { name: string }) => `${name} replied to you`,
      sender: ({ name }: { name: string }) => `New message from ${name}`,
      added: ({ name }: { name: string }) => `${name} added you to this chat`,
      image: "sent an image",
      file: "sent a document",
      more: ({ count }: { count: number }) => ` (+${count} more)`,
      open: "Open chat",
    },
    de: {
      mention: ({ name }: { name: string }) => `${name} hat dich erwähnt`,
      reply: ({ name }: { name: string }) => `${name} hat dir geantwortet`,
      sender: ({ name }: { name: string }) => `Neue Nachricht von ${name}`,
      added: ({ name }: { name: string }) => `${name} hat dich in diesen Chat geholt`,
      image: "hat ein Bild geschickt",
      file: "hat ein Dokument geschickt",
      more: ({ count }: { count: number }) => ` (+${count} weitere)`,
      open: "Chat öffnen",
    },
  },
});
export const PushDataSchema = z.object({
  chat: z.string(),
  title: z.string(),
  sender: z.string(),
  firstName: z.string(),
  agent: z.boolean(),
  text: z.string(),
  attachment: z.enum(["image", "file"]).nullable(),
  reason: z.enum(["mention", "reply", "follow", "message", "added"]),
  threadName: z.string().nullable(),
  href: z.templateLiteral(["/", z.string()]),
  further: z.number().int().nonnegative(),
  preview: z.boolean(),
  badge: z.number().int().nonnegative(),
  alert: z.boolean(),
});
export type PushData = z.infer<typeof PushDataSchema>;
export const renderPush = (data: PushData, { locale }: { locale: string }) => {
  const { t } = copy.resolve([locale]);
  const name = `${data.sender}${data.agent ? " (Agent)" : ""}`;
  const first = `${data.agent ? data.sender : data.firstName}${data.agent ? " (Agent)" : ""}`;
  const title = !data.preview
    ? data.title
    : data.reason === "mention"
      ? t.mention({ name })
      : data.reason === "reply"
        ? t.reply({ name })
        : data.reason === "follow" && data.threadName
          ? `${data.title} · ${data.threadName}`
          : data.title;
  const summary =
    data.reason === "added"
      ? t.added({ name })
      : !data.preview
        ? t.sender({ name })
        : `${first}: ${data.text || (data.attachment === "image" ? t.image : data.attachment === "file" ? t.file : t.sender({ name }))}`;
  const suffix = data.further ? t.more({ count: data.further }) : "";
  // Keep the bundled count visible inside the platform's 200-code-unit preview limit.
  const location = data.preview && (data.reason === "mention" || data.reason === "reply") ? `${data.title} · ` : "";
  const preview = `${truncate(location + summary, 200 - suffix.length)}${suffix}`;
  return {
    title: truncate(title, 200),
    preview,
    body: `${summary}\n\n${t.open}: ${data.href}`,
    targetHref: data.href,
    group: data.chat,
    badge: data.badge,
    alert: data.alert,
  };
};
const common = { recipient: "user" as const, data: PushDataSchema, delivery: { recommended: ["browser" as const] }, render: renderPush };
export const NOTIFICATIONS = {
  mention: notification({
    ...common,
    label: "Mentions and replies",
    description: "When someone mentions you, replies to you, or posts in a discussion you follow.",
    presentation: {
      baseLocale: "en",
      translations: {
        de: {
          label: "Erwähnungen und Antworten",
          description: "Wenn dich jemand erwähnt, dir antwortet oder in einer Diskussion schreibt, der du folgst.",
        },
      },
    },
  }),
  message: notification({
    ...common,
    label: "New messages",
    description: "For chats set to All messages. Choose these chats under Info in Chat.",
    delivery: { recommended: ["browser"], excluded: ["email"] },
    excludedReason: "Unavailable: an email for every message would be too much.",
    presentation: {
      baseLocale: "en",
      translations: {
        de: {
          label: "Neue Nachrichten",
          description: "Für Chats mit der Stufe „Alle Nachrichten“. Welche Chats das sind, stellst du im Chat unter Info ein.",
          excludedReason: "Nicht verfügbar: Jede Nachricht als E-Mail wäre zu viel.",
        },
      },
    },
  }),
  added: notification({
    ...common,
    label: "Added to a chat",
    description: "When someone adds you to a chat.",
    presentation: {
      baseLocale: "en",
      translations: {
        de: {
          label: "Zu einem Chat hinzugefügt",
          description: "Wenn dich jemand in einen Chat holt.",
        },
      },
    },
  }),
};
