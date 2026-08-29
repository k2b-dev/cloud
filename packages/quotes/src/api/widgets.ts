import { i18n } from "@k2b/stdlib";
import type { WidgetResponse } from "@valentinkolb/cloud/contracts";
import { getLocale } from "@valentinkolb/cloud/server";
import { Hono } from "hono";
import { quotesService } from "../service";

const widgetMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: { title: "Quote of the hour", unavailable: "No quote right now", retry: "Provider unreachable — try again in a minute" },
    de: {
      title: "Zitat der Stunde",
      unavailable: "Derzeit kein Zitat",
      retry: "Der Anbieter ist nicht erreichbar. Versuche es in einer Minute erneut.",
    },
  },
});

type QuoteWidgetResult = Awaited<ReturnType<typeof quotesService.quote.get>>;

export const quoteWidgetBody = (result: QuoteWidgetResult, locale: string): WidgetResponse => {
  const { t } = widgetMessages.resolve([locale]);
  return result.ok
    ? {
        title: t.title,
        icon: "ti ti-quote",
        blocks: [{ kind: "hero", icon: "ti ti-quote", tone: "blue", title: result.data.text, subtitle: `— ${result.data.author}` }],
      }
    : {
        title: t.title,
        icon: "ti ti-quote",
        blocks: [{ kind: "placeholder", icon: "ti ti-cloud-off", title: t.unavailable, description: t.retry }],
      };
};

/**
 * Widget endpoints for the dashboard. Public — no auth gate, mirrors the
 * normal quote endpoint. Returns 200 with a `WidgetResponse` payload that
 * the dashboard renders into a `<Widget>` with one Status block.
 */
const app = new Hono().get("/quote", async (c) => {
  const result = await quotesService.quote.get();
  return c.json(quoteWidgetBody(result, getLocale(c)));
});

export default app;
