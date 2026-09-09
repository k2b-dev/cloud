import { LinkCard } from "@k2b/ui";
import { getLocale, type AuthContext } from "@k2b/cloud/server";
import { AdminLayout, getLocalizedRuntimeContext, hasDedicatedRuntimeRoute } from "@k2b/cloud/ssr";
import { ssr } from "../../config";
import { adminMessages } from "./messages";

const platformTasks = (t: ReturnType<typeof adminMessages.resolve>["t"]) =>
  [
    {
      href: "/admin/settings?tab=general",
      title: t.generalSettings,
      description: t.generalSettingsDescription,
      icon: "ti ti-app-window",
      color: "blue",
    },
    {
      href: "/admin/settings?tab=security",
      title: t.security,
      description: t.securityDescription,
      icon: "ti ti-shield-lock",
      color: "emerald",
    },
    {
      href: "/admin/settings?tab=mail",
      title: t.mail,
      description: t.mailDescription,
      icon: "ti ti-mail",
      color: "orange",
    },
    {
      href: "/admin/settings?tab=ai-providers",
      title: t.aiProviders,
      description: t.aiProvidersDescription,
      icon: "ti ti-sparkles",
      color: "violet",
    },
    {
      href: "/admin/announcements",
      title: t.announcements,
      description: t.announcementsDescription,
      icon: "ti ti-speakerphone",
      color: "amber",
    },
    {
      href: "/admin/settings?tab=legal",
      title: t.legal,
      description: t.legalDescription,
      icon: "ti ti-file-text",
      color: "zinc",
    },
  ] as const;

export default ssr<AuthContext>(async (c) => {
  const t = adminMessages.resolve([getLocale(c)]).t;
  const allApps = getLocalizedRuntimeContext(c).apps;
  const adminApps = allApps.filter((app) => !!app.adminHref && app.id !== "gateway-ops").sort((a, b) => a.name.localeCompare(b.name));
  const gatewayAdminAvailable = hasDedicatedRuntimeRoute(allApps, "/admin/gateway", "core");
  const observabilityAvailable = hasDedicatedRuntimeRoute(allApps, "/admin/observability", "core");
  const primaryDestination = observabilityAvailable
    ? {
        href: "/admin/observability",
        eyebrow: t.operations,
        title: t.investigateSystem,
        description: t.investigateDescription,
        action: t.openObservability,
        icon: "ti ti-stethoscope",
      }
    : {
        href: "/admin/settings?tab=general",
        eyebrow: t.configuration,
        title: t.configureInstance,
        description: t.configureDescription,
        action: t.openSettings,
        icon: "ti ti-settings",
      };

  return () => (
    <AdminLayout c={c} title={t.overview}>
      <div class="app-rows mx-auto w-full max-w-6xl">
        <header class="flex flex-wrap items-end justify-between gap-3" style="view-transition-name: admin-overview-title">
          <div class="min-w-0">
            <h1 class="text-base font-semibold text-primary">{t.administration}</h1>
            <p class="mt-1 text-xs text-dimmed">{t.administrationDescription}</p>
          </div>
          <div class="flex flex-wrap gap-1 text-[10px] tabular-nums text-dimmed">
            <span class="rounded-[var(--ui-radius-control)] bg-[var(--ui-surface-subtle)] px-2 py-1">
              {t.registeredServices({ count: allApps.length })}
            </span>
            <span class="rounded-[var(--ui-radius-control)] bg-[var(--ui-surface-subtle)] px-2 py-1">
              {t.appAdminAreas({ count: adminApps.length })}
            </span>
          </div>
        </header>

        <section aria-labelledby="admin-start-heading">
          <div class="mb-2">
            <h2 id="admin-start-heading" class="text-xs font-semibold text-primary">
              {t.startHere}
            </h2>
            <p class="text-[10px] text-dimmed">{t.chooseTask}</p>
          </div>

          <div class="grid gap-2 lg:grid-cols-3">
            <a
              href={primaryDestination.href}
              class="paper group flex min-h-44 flex-col justify-between p-4 transition-colors hover:paper-highlighted focus-visible:outline-none focus-visible:[box-shadow:var(--ui-focus)] lg:col-span-2"
            >
              <div>
                <span
                  class="grid size-9 place-items-center rounded-[var(--ui-radius-control)] text-[var(--ui-app-accent-text)]"
                  style="background-color: color-mix(in srgb, var(--app-accent) 12%, var(--ui-surface))"
                >
                  <i class={`${primaryDestination.icon} text-lg`} aria-hidden="true" />
                </span>
                <p class="mt-4 text-[10px] font-medium text-dimmed">{primaryDestination.eyebrow}</p>
                <h3 class="mt-1 text-lg font-semibold text-primary">{primaryDestination.title}</h3>
                <p class="mt-1 max-w-2xl text-xs text-secondary">{primaryDestination.description}</p>
              </div>
              <span class="mt-4 inline-flex items-center gap-1 text-xs font-medium text-primary">
                {primaryDestination.action}
                <i class="ti ti-arrow-up-right transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
              </span>
            </a>

            <div class="grid gap-2 sm:grid-cols-2 lg:grid-cols-1">
              {gatewayAdminAvailable ? (
                <LinkCard
                  href="/admin/gateway/apps"
                  title={t.appsAndRoutes}
                  description={t.appsAndRoutesDescription}
                  icon="ti ti-route-scan"
                  color="cyan"
                />
              ) : (
                <LinkCard
                  href="/admin/announcements"
                  title={t.announcements}
                  description={t.announcementsDescription}
                  icon="ti ti-speakerphone"
                  color="amber"
                />
              )}
              <LinkCard
                href="/admin/settings?tab=user"
                title={t.peopleAndAccess}
                description={t.peopleAndAccessDescription}
                icon="ti ti-users"
                color="blue"
              />
            </div>
          </div>
        </section>

        <section aria-labelledby="platform-tasks-heading">
          <div class="mb-2">
            <h2 id="platform-tasks-heading" class="text-xs font-semibold text-primary">
              {t.platformConfiguration}
            </h2>
            <p class="text-[10px] text-dimmed">{t.platformConfigurationDescription}</p>
          </div>
          <div class="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {platformTasks(t).map((task) => (
              <LinkCard href={task.href} title={task.title} description={task.description} icon={task.icon} color={task.color} />
            ))}
          </div>
        </section>

        {adminApps.length > 0 ? (
          <section aria-labelledby="app-admin-heading">
            <div class="mb-2">
              <h2 id="app-admin-heading" class="text-xs font-semibold text-primary">
                {t.appAdministration}
              </h2>
              <p class="text-[10px] text-dimmed">{t.appAdministrationDescription}</p>
            </div>
            <div class="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {adminApps.map((app) => (
                <LinkCard href={app.adminHref!} title={app.name} description={app.description} icon={app.icon} color="zinc" />
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </AdminLayout>
  );
});
