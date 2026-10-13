import { createContext, type JSX, useContext } from "solid-js";
import type { AppSearchLink } from "../contracts/app";
import type { RailSnapshot } from "../contracts/rail-preferences";
import type { CloudThemePreference } from "../shared/theme";
import type { AppLaunchpadLegalLink } from "./app-launchpad";
import type { GlobalSearchHelpApp } from "./GlobalSearchHelpDialog";
import type { RailApp } from "./rail-navigation";

export type ShellData = {
  /** The authorized navigation catalog, sorted for the request locale: the rail, the app grid and the phone menu show it. */
  apps: RailApp[];
  /** Signed-in pages: the person's rail preferences. */
  rail?: RailSnapshot;
  legalLinks: AppLaunchpadLegalLink[];
  /** Signed-in pages: the person, for the profile menu and the phone menu's profile actions. */
  profile?: { name: string; avatarSrc?: string; appHref?: string };
  theme: CloudThemePreference;
  /** The current app's accent, for the Help dialog and the phone menu, which open outside the app canvas. */
  accent?: string;
  /** The search destinations of each app in `apps`, by app id in registry order; the search host expands them into rows. */
  searchLinks: Record<string, readonly AppSearchLink[]>;
  searchHelpApps: GlobalSearchHelpApp[];
};

const ShellDataContext = createContext<() => ShellData>();

export function ShellDataProvider(props: { data: ShellData; children: JSX.Element }) {
  return (
    <ShellDataContext.Provider value={() => props.data}>
      <script id="cloud-shell-data" type="application/json" innerHTML={JSON.stringify(props.data).replace(/</g, "\\u003c")} />
      {props.children}
    </ShellDataContext.Provider>
  );
}

export function readShellData(): ShellData | undefined {
  if (typeof document === "undefined") return undefined;
  const text = document.getElementById("cloud-shell-data")?.textContent;
  if (!text) return undefined;
  // Framework-generated, escaped SSR data; never loaded from localStorage. The server validates the rail snapshot when
  // it reads it, so the shell does not load the schemas on every page.
  const data: ShellData = JSON.parse(text);
  return data;
}

export function useShellData(): ShellData | undefined {
  return useContext(ShellDataContext)?.() ?? readShellData();
}
