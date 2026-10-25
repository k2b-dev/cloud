import type { PanelConsentSnapshot } from "../contracts/panel-context";
import type { RailSnapshot } from "../contracts/rail-preferences";
import type { User } from "../contracts/shared";
import type { AuthContext } from "../server/middleware/auth";
import type { LayoutAnnouncementsState } from "../server/middleware/settings";
import type { RuntimeContext } from "./runtime";

export type LayoutContext = {
  get(key: "actor"): AuthContext["Variables"]["actor"] | undefined;
  get(key: "user"): User | undefined;
  get(key: "panelConsent"): PanelConsentSnapshot | undefined;
  get(key: "railPreferences"): RailSnapshot | undefined;
  get(key: "page"): { theme?: "light" | "dark"; title?: string; pwa?: { name: string }; pwaAddress?: string; pwaOwner?: string };
  get(key: "runtime"): RuntimeContext;
  get(key: "announcements"): LayoutAnnouncementsState | undefined;
  /** Every application settings snapshot includes Core's app metadata. */
  get(key: "settings"): Record<string, any>;
  req: { raw: { headers: Headers; url: string } };
};

export type MinimalLayoutContext = Pick<LayoutContext, "get" | "req">;
