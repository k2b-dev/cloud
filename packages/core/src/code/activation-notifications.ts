import { notification } from "@k2b/cloud";
import { cloudResourceHref, validateNotificationTargetHref } from "@k2b/cloud/contracts";
import { i18n } from "@k2b/stdlib";
import { z } from "zod";

const messages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      title: "Code access enabled by a Cloud administrator",
      body: ({ title }: { title: string }) => `A Cloud administrator enabled “${title}” with access to a resource you manage.`,
    },
    de: {
      title: "Code-Zugriff durch Cloud-Admin eingeschaltet",
      body: ({ title }) => `Ein Cloud-Admin hat „${title}“ mit Zugriff auf eine von dir verwaltete Ressource eingeschaltet.`,
    },
  },
});
/** One idempotent notice per activation, affected target and human manager. The notice grants no access to its sender. */
export const CODE_ACTIVATION_NOTIFICATIONS = {
  codeAccessEnabled: notification({
    recipient: "user",
    label: "Code access enabled",
    description: "A Cloud administrator enables Code access to a resource you manage.",
    presentation: {
      baseLocale: "en",
      translations: {
        de: {
          label: "Code-Zugriff eingeschaltet",
          description: "Ein Cloud-Admin schaltet Code-Zugriff auf eine von dir verwaltete Ressource ein.",
        },
      },
    },
    delivery: { recommended: ["browser", "email"] },
    data: z.object({ title: z.string(), target: z.object({ type: z.string(), id: z.string() }) }),
    render: (data, { locale }) => {
      const { t } = messages.resolve([locale]);
      return {
        title: t.title,
        body: t.body(data),
        ...(data.target.type === "app" ? {} : { targetHref: validateNotificationTargetHref(cloudResourceHref(data.target)) }),
      };
    },
    email: (data, { locale }) => {
      const { t } = messages.resolve([locale]);
      return { subject: t.title, content: t.body(data) };
    },
  }),
};
