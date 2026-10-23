import type { Context } from "hono";
import { readPanelCookie } from "../_internal/panel-cookie";
import { getLocale } from "../server/locale";
import { panelContextConsent } from "../services/panel-context-consent";
import { visiblePanelProviders } from "./app-navigation";
import { getDisplayRuntimeContext } from "./runtime";

/** One read, only for a host page with the slot open on a consent provider. Fail closed when the store is unavailable. */
export async function preloadPanelConsent(c: Context): Promise<void> {
  const user = c.get("user");
  if (!user || !c.get("runtime")) return;
  const providers = visiblePanelProviders(getDisplayRuntimeContext(c).apps, user, getLocale(c));
  const state = readPanelCookie(
    c.req.header("Cookie"),
    providers.map((provider) => provider.id),
  );
  const provider = state.open && providers.find((provider) => provider.id === state.provider);
  if (!provider || !provider.consent) return;
  // The provider's own page below its panel path renders in PanelLayout, which has no slot and never asks.
  const scope = new URL(provider.href, "https://panel.invalid").pathname.replace(/\/$/, "");
  if (c.req.path === scope || c.req.path.startsWith(`${scope}/`)) return;
  let answer: { allowed: boolean; revision: number } | null = null;
  try {
    answer = await panelContextConsent.get(user.id, provider.id);
  } catch {
    // The shell shows the unanswered question, without context in the URL or messages.
  }
  c.set("panelConsent", { provider: provider.id, allowed: answer?.allowed ?? null, revision: answer?.revision ?? 0 });
}
