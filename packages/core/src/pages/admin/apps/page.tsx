import { appAccessMessages } from "@k2b/cloud/access/ui";
import { type AuthContext, auth, getLocale } from "@k2b/cloud/server";
import { AppAccessManagementError, appAccessGrantCounts, canRepairAppAccess, logger, readAppAccess } from "@k2b/cloud/services";
import { AdminLayout, getLocalizedRuntimeContext } from "@k2b/cloud/ssr";
import { appAccentStyle } from "@k2b/cloud/ssr/app-appearance";
import { ButtonLink, IconButtonLink } from "@k2b/ui";
import { Show } from "solid-js";
import { ssr } from "../../../config";
import Access from "./Access.island";

export default ssr<AuthContext>(async (c) => {
  const t = appAccessMessages.resolve([getLocale(c)]).t;
  const authority = auth.getAuthority(c);
  if (!canRepairAppAccess(authority)) return ssr.error(c, 403);
  const apps = getLocalizedRuntimeContext(c).apps.toSorted((a, b) => a.name.localeCompare(b.name));
  const selected = apps.find((app) => app.id === c.req.query("app"));
  const counts = selected ? new Map<string, number>() : await appAccessGrantCounts(authority, apps);
  const initial =
    selected?.access?.kind === "grants"
      ? await readAppAccess({ app: selected, authority, repair: true }).catch((error: unknown) => {
          if (!(error instanceof AppAccessManagementError && error.status === 403))
            logger("app-access").error("Could not load the access repair list", { appId: selected.id, error });
          // The editor retries the canonical read and exposes a recoverable error or terminal 403.
          return undefined;
        })
      : undefined;
  const rule = (app: (typeof apps)[number]) => {
    switch (app.access?.kind) {
      case "grants":
        return t.configurable;
      case "signedIn":
        return t.fixedSignedInLabel;
      case "noGuests":
        return t.fixedNoGuestsLabel;
      case "roles":
        return app.access.roles.length === 1 && app.access.roles[0] === "admin" ? t.fixedAdminsLabel : t.fixedRolesLabel;
      default:
        return t.legacyLabel;
    }
  };
  return () => (
    <AdminLayout c={c} contentClass="px-4 pt-2 pb-24 sm:px-8 sm:pt-5 sm:pb-12" title={selected ? `${selected.name} · ${t.access}` : t.apps}>
      <Show
        when={selected}
        fallback={
          <div class="w-full max-w-[900px]">
            <h1 class="mb-3 text-lg font-semibold sm:text-xl">{t.apps}</h1>
            <p class="mb-5 max-w-[720px] text-sm text-secondary">{t.overview}</p>
            <div class="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto_auto]">
              <div class="col-span-full hidden grid-cols-subgrid gap-x-3 px-2 py-2 text-xs text-dimmed sm:grid">
                <span>{t.app}</span>
                <span>{t.rule}</span>
                <span aria-hidden="true" />
                <span class="sr-only">{t.repair}</span>
              </div>
              {apps.map((app) => (
                <div class="col-span-full grid min-h-[52px] grid-cols-subgrid items-center gap-x-3 rounded-[var(--ui-radius-control)] px-2 py-2.5 hover:bg-[var(--ui-surface-subtle)]">
                  <div class="min-w-0 sm:contents">
                    <div class="flex min-w-0 items-center gap-3">
                      <span
                        class="app-accent-scope k2b-icon-tile app-accent-text flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
                        style={appAccentStyle(app.appearance?.accent)}
                        aria-hidden="true"
                      >
                        <i class={app.icon} />
                      </span>
                      <span class="truncate text-sm font-medium">{app.name}</span>
                    </div>
                    <div class="pl-11 text-[13px] text-dimmed sm:pl-0">
                      <span>{rule(app)}</span>
                      <Show when={app.access?.kind === "grants"}>
                        <span class="sm:hidden"> · {t.count({ count: counts.get(app.id) ?? 0 })}</span>
                      </Show>
                    </div>
                  </div>
                  <span class="hidden text-[13px] text-dimmed sm:block">
                    <Show when={app.access?.kind === "grants"}>{t.count({ count: counts.get(app.id) ?? 0 })}</Show>
                  </span>
                  <div>
                    <Show when={app.access?.kind === "grants"}>
                      <ButtonLink
                        href={`/admin/apps?app=${encodeURIComponent(app.id)}`}
                        variant="secondary"
                        aria-label={`${app.name}: ${t.repair}`}
                      >
                        <span class="sm:hidden">{t.repairShort}</span>
                        <span class="hidden sm:inline">{t.repair}</span>
                      </ButtonLink>
                    </Show>
                  </div>
                </div>
              ))}
            </div>
          </div>
        }
      >
        {(app) => (
          <div class="flex flex-col gap-5">
            <div class="flex items-center gap-3">
              <IconButtonLink href="/admin/apps" variant="ghost" style={{ width: "36px", "min-height": "36px" }} label={t.backToApps}>
                <i class="ti ti-arrow-left" />
              </IconButtonLink>
              <h1 class="text-lg font-semibold sm:text-xl">
                {app().name} · {t.access}
              </h1>
            </div>
            <Access app={app()} initial={initial} repair />
          </div>
        )}
      </Show>
    </AdminLayout>
  );
});
