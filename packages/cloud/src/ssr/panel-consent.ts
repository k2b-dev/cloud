import type { Context } from "hono";
import { readPanelCookie, readPanelUnsure } from "../_internal/panel-cookie";
import { getLocale } from "../server/locale";
import { panelContextConsent } from "../services/panel-context-consent";
import { visiblePanelProviders } from "./app-navigation";
import { getRuntimeContext } from "./runtime";

/** One read, only for the persisted open provider. Fail closed when the consent store is unavailable. */
export async function preloadPanelConsent(c: Context): Promise<void> {
  const user = c.get("user");
  if (!user || !c.get("runtime")) return;
  const providers = visiblePanelProviders(getRuntimeContext(c).apps, user, getLocale(c));
  const state = readPanelCookie(
    c.req.header("Cookie"),
    providers.map((provider) => provider.id),
  );
  const provider = state.open && providers.find((provider) => provider.id === state.provider);
  if (!provider || !provider.consent) return;
  let answer: { allowed: boolean; revision: number } | null = null;
  try {
    answer = await panelContextConsent.get(user.id, provider.id);
  } catch {
    // The shell shows the unanswered question, without context in the URL or messages.
  }
  // A save of this browser with an unknown outcome may still land: ask again instead of trusting the stored answer.
  const unsure = readPanelUnsure(c.req.header("Cookie"), [provider.id]).length > 0;
  c.set("panelConsent", {
    provider: provider.id,
    allowed: unsure ? null : (answer?.allowed ?? null),
    revision: answer?.revision ?? 0,
  });
}
