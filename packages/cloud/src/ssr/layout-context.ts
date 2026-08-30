import type { User } from "../contracts/shared";
import type { LayoutAnnouncementsState } from "../server/middleware/settings";
import type { RuntimeContext } from "./runtime";

export type LayoutContext = {
  get(key: "user"): User | undefined;
  get(key: "page"): { theme?: "light" | "dark" };
  get(key: "runtime"): RuntimeContext;
  get(key: "announcements"): LayoutAnnouncementsState | undefined;
  /** Every application settings snapshot includes Core's app metadata. */
  get(key: "settings"): Record<string, any>;
  req: { raw: { headers: Headers; url: string } };
};

export type MinimalLayoutContext = Pick<LayoutContext, "get" | "req">;
