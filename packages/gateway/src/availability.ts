import type { AppRegistryEntry } from "@k2b/cloud/contracts";
import type { GatewayStatus, MaintenanceState } from "@k2b/cloud/contracts/maintenance";
import type { ObservedMaintenance } from "@k2b/cloud/services/maintenance-state";
import { resolveAppIdentityPresentation } from "@k2b/cloud/shared";
import { buildAppRoutes } from "./routes";

/**
 * What the gateway knows, in memory, to answer by itself while the Cloud or
 * one app is away: the maintenance state, the Cloud's name, logo and time
 * zone, every live app's icon, and apps that left the registry recently.
 * Nothing here reads Postgres or Core at request time.
 */

export type AppUnavailableReason = "updating" | "unavailable";

/** A vanished app stays known this long, so its paths get its page instead of a fallback route's 404. */
export const VANISHED_APP_MS = 15 * 60 * 1000;
export const MAX_VANISHED_APPS = 32;
/** A clean deregistration and the registry refresh that drops the app arrive separately; pair them within this window. */
const REMOVAL_PAIRING_MS = 60_000;
const ICON_RETRY_MS = 5 * 60 * 1000;
/**
 * A crashed app keeps its registry lease for minutes. While its last proxied request failed within this window,
 * the status endpoint calls it unavailable, so open pages do not reload into the same error again and again.
 */
export const UPSTREAM_FAILURE_MS = 15_000;

export type CloudBranding = {
  name: string;
  /** `data:` URI, used only as an image source. */
  logo?: string;
  timeZone: string;
  /** Operator default locale (`app.locale`). */
  locale: string;
};

type KnownApp = {
  id: string;
  name: string;
  presentation?: AppRegistryEntry["presentation"];
  accent?: string;
  icon?: string;
  /** Normalized prefixes the gateway accepted for this app; the /app/<id> and /pwa rules already applied. */
  prefixes: string[][];
};
type VanishedApp = KnownApp & { reason: AppUnavailableReason; at: number };

export type AppView = { id: string; name: string; icon?: string; accent?: string };

const ACCENT = /^#[0-9a-f]{6}$/i;

const segments = (path: string): string[] => path.split("/").filter(Boolean);

const knownApp = (app: AppRegistryEntry, icon: string | undefined): KnownApp => ({
  id: app.id,
  name: app.name,
  ...(app.presentation ? { presentation: app.presentation } : {}),
  ...(app.appearance?.accent && ACCENT.test(app.appearance.accent) ? { accent: app.appearance.accent } : {}),
  ...(icon ? { icon } : {}),
  prefixes: buildAppRoutes([app]).map((route) => segments(route.prefix)),
});

/**
 * The generated favicon strokes the glyph with a blue gradient (packages/cloud/scripts/app-favicon.ts). On the
 * page it sits in a tile tinted with the app's accent, and an `<img>` cannot inherit a colour, so the stroke takes
 * the accent here. Any other SVG stays as the app served it.
 */
export const tintAppIcon = (svg: string, accent: string | undefined): string =>
  accent && /^#[0-9a-f]{6}$/i.test(accent) ? svg.replace('stroke="url(#cloud-icon)"', `stroke="${accent}"`) : svg;

/** Version key for an app's generated favicon: refetch only when the app runs another build or restarts. */
export const appIconKey = (app: AppRegistryEntry): string => String(app.runtime?.version ?? app.runtime?.release ?? app.startedAt ?? "");

export const createAvailability = ({ now = Date.now }: { now?: () => number } = {}) => {
  let maintenance: ObservedMaintenance | null = null;
  let branding: CloudBranding = { name: "Cloud", timeZone: "UTC", locale: "en" };
  let live = new Map<string, AppRegistryEntry>();
  const icons = new Map<string, { key: string; src?: string; at: number }>();
  const vanished = new Map<string, VanishedApp>();
  const cleanRemovals = new Map<string, number>();
  const upstreamFailures = new Map<string, number>();

  const prune = () => {
    const cutoff = now() - VANISHED_APP_MS;
    for (const [id, app] of vanished) if (app.at <= cutoff) vanished.delete(id);
    for (const [id, at] of cleanRemovals) if (at <= now() - REMOVAL_PAIRING_MS) cleanRemovals.delete(id);
    // Map order is insertion order: drop the oldest beyond the bound.
    for (const id of vanished.keys()) {
      if (vanished.size <= MAX_VANISHED_APPS) break;
      vanished.delete(id);
    }
    for (const id of icons.keys()) if (!live.has(id) && !vanished.has(id)) icons.delete(id);
    for (const [id, at] of upstreamFailures) if (!live.has(id) || at <= now() - UPSTREAM_FAILURE_MS) upstreamFailures.delete(id);
  };

  const available = (appId: string): boolean => {
    if (!live.has(appId)) return false;
    const failedAt = upstreamFailures.get(appId);
    return failedAt === undefined || failedAt <= now() - UPSTREAM_FAILURE_MS;
  };

  return {
    maintenance: (): MaintenanceState | null => maintenance?.state ?? null,
    observedMaintenance: (): ObservedMaintenance | null => maintenance,
    /** Returns true when maintenance just started, so open sockets can be closed once. */
    setMaintenance: (next: ObservedMaintenance | null): boolean => {
      const started = !maintenance && !!next;
      maintenance = next;
      return started;
    },

    branding: (): CloudBranding => branding,
    setBranding: (next: CloudBranding) => {
      branding = next;
    },

    /** Replace the live app set from a confirmed registry snapshot; apps that left become vanished. */
    updateApps: (apps: readonly AppRegistryEntry[]) => {
      const next = new Map(apps.map((app) => [app.id, app]));
      for (const [id, previous] of live) {
        if (next.has(id)) continue;
        const clean = cleanRemovals.has(id);
        cleanRemovals.delete(id);
        vanished.delete(id);
        vanished.set(id, { ...knownApp(previous, icons.get(id)?.src), reason: clean ? "updating" : "unavailable", at: now() });
      }
      for (const id of next.keys()) vanished.delete(id);
      live = next;
      prune();
    },

    /** A registry removal event. `delete` is a clean deregistration on shutdown; `expire` a lost lease. */
    noteRemoval: (appId: string, reason: "delete" | "expire") => {
      const app = vanished.get(appId);
      if (app) {
        if (reason === "delete" && app.at > now() - REMOVAL_PAIRING_MS) app.reason = "updating";
        return;
      }
      if (reason === "delete") cleanRemovals.set(appId, now());
      else cleanRemovals.delete(appId);
      prune();
    },

    /** Apps whose icon must be (re)fetched: new build or restart, or a failed fetch older than the retry delay. */
    iconsDue: (): AppRegistryEntry[] =>
      [...live.values()].filter((app) => {
        if (app.id === "core") return false;
        const cached = icons.get(app.id);
        return !cached || cached.key !== appIconKey(app) || (!cached.src && cached.at <= now() - ICON_RETRY_MS);
      }),
    setIcon: (appId: string, key: string, src: string | undefined) => {
      icons.set(appId, { key, ...(src ? { src } : {}), at: now() });
    },

    /** The proxy could not reach a registered app; a later answer from it clears this at once. */
    upstreamFailed: (appId: string) => {
      if (live.has(appId)) upstreamFailures.set(appId, now());
    },
    upstreamAnswered: (appId: string) => {
      if (upstreamFailures.size > 0) upstreamFailures.delete(appId);
    },

    /** Registered right now. Unknown or malformed ids are simply not available. */
    isLive: (appId: string): boolean => live.has(appId),

    /**
     * The recently vanished app that owned a longer prefix of `pathname` than the live match
     * (`matchedPrefix`, `null` when nothing live matched), with the reason it is gone.
     */
    vanishedOwner: (pathname: string, matchedPrefix: string | null): { appId: string; reason: AppUnavailableReason } | null => {
      if (vanished.size === 0) return null;
      prune();
      const path = segments(pathname);
      const liveLength = matchedPrefix === null ? -1 : segments(matchedPrefix).length;
      let best: { app: VanishedApp; length: number } | null = null;
      for (const app of vanished.values()) {
        for (const prefix of app.prefixes) {
          if (prefix.length <= liveLength || prefix.length <= (best?.length ?? -1)) continue;
          if (prefix.every((part, index) => path[index] === part)) best = { app, length: prefix.length };
        }
      }
      return best ? { appId: best.app.id, reason: best.app.reason } : null;
    },

    /** Name in `locale`, icon and accent of a live or recently vanished app; Core is the Cloud itself. */
    appView: (appId: string, locale: string): AppView => {
      if (appId === "core") return { id: appId, name: branding.name, ...(branding.logo ? { icon: branding.logo } : {}) };
      const entry = live.get(appId);
      const app = entry ? knownApp(entry, icons.get(appId)?.src) : vanished.get(appId);
      if (!app) return { id: appId, name: appId };
      const { name } = resolveAppIdentityPresentation({ name: app.name, description: "", presentation: app.presentation }, locale);
      return { id: appId, name, ...(app.icon ? { icon: app.icon } : {}), ...(app.accent ? { accent: app.accent } : {}) };
    },

    /** Why a known app is away right now: a clean deregistration says "updating"; everything else "unavailable". */
    reasonFor: (appId: string): AppUnavailableReason => (!live.has(appId) && vanished.get(appId)?.reason) || "unavailable",

    status: (appId: string | null): GatewayStatus => {
      const state = maintenance?.state;
      return {
        maintenance: state ? { active: true, until: state.until ? new Date(state.until).toISOString() : null } : null,
        ...(appId !== null ? { app: { available: available(appId) } } : {}),
      };
    },
  };
};

export type Availability = ReturnType<typeof createAvailability>;

/** The gateway process's single view. */
export const availability = createAvailability();
