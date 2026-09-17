import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { AdminLayout } from "@k2b/cloud/ssr";
import { ButtonLink, Format, InlineGuidance, Paper, StatusBadge } from "@k2b/ui";
import { For, Show } from "solid-js";
import { ssr } from "../config";
import { AdminQuerySchema, type AdminResult, type Area, type BaseKind } from "../contracts";
import { FilesError, filesService } from "../service";
import { IssueMessage } from "./feedback";
import Inventory from "./Inventory.island";
import { filesMessages } from "./messages";
import Settings from "./Settings.island";
import { adminUrl } from "./urls";

export default ssr<AuthContext>(async (c) => {
  const { t } = filesMessages.resolve([getLocale(c)]);
  const query = AdminQuerySchema.safeParse(c.req.query());
  if (!query.success) return ssr.error(c, 400);
  const { area, kind, after } = query.data;
  let result: AdminResult;
  try {
    result = await filesService.admin(c.get("actor"), query.data);
  } catch (error) {
    if (!(error instanceof FilesError)) throw error;
    return ssr.error(c, error.status, { description: t.unavailable });
  }
  const areas: Area[] = ["cloud", "freeipa"];
  const kinds: BaseKind[] = ["users", "groups"];
  return () => (
    <AdminLayout c={c} title={t.admin}>
      <div class="app-rows min-w-0">
        <h1 class="text-base font-semibold text-primary">{t.admin}</h1>
        <section class="flex min-w-0 flex-col gap-3" aria-label={t.inventory}>
          <div>
            <h2 class="text-sm font-semibold text-primary">{t.inventory}</h2>
            <p class="mt-1 text-sm text-dimmed">{t.inventoryDescription}</p>
          </div>
          <div class="flex flex-wrap items-center justify-between gap-3">
            <nav aria-label={t.storage} class="flex flex-wrap gap-2">
              <For each={areas}>
                {(value) => (
                  <ButtonLink
                    size="sm"
                    variant={value === area ? "secondary" : "ghost"}
                    aria-current={value === area ? "page" : undefined}
                    href={adminUrl(value, kind)}
                  >
                    {t[value]}
                  </ButtonLink>
                )}
              </For>
            </nav>
            <nav aria-label={t.inventory} class="flex flex-wrap gap-2">
              <For each={kinds}>
                {(value) => (
                  <ButtonLink
                    size="sm"
                    variant={value === kind ? "secondary" : "ghost"}
                    aria-current={value === kind ? "page" : undefined}
                    href={adminUrl(area, value)}
                  >
                    {value === "users" ? t.users : t.groupPlural}
                  </ButtonLink>
                )}
              </For>
            </nav>
            <ButtonLink size="sm" variant="secondary" href={adminUrl(area, kind, after)}>
              <i class="ti ti-refresh" aria-hidden="true" />
              {t.refresh}
            </ButtonLink>
          </div>
          <Show when={result.issue} fallback={<Inventory items={result.items} />}>
            <InlineGuidance tone="warning">
              <IssueMessage code={result.issue} />
            </InlineGuidance>
          </Show>
          <p class="text-xs text-dimmed">{t.unknownDescription}</p>
          <nav class="flex flex-wrap gap-2" aria-label={t.inventory}>
            <Show when={after}>
              <ButtonLink size="sm" variant="secondary" href={adminUrl(area, kind)}>
                {t.first}
              </ButtonLink>
            </Show>
            <Show when={result.next}>
              {(next) => (
                <ButtonLink size="sm" variant="secondary" href={adminUrl(area, kind, next())}>
                  {t.next}
                </ButtonLink>
              )}
            </Show>
          </nav>
        </section>
        <Show when={result.root}>
          {(root) => (
            <Paper class="flex flex-col gap-3 p-4">
              <h2 class="text-sm font-semibold text-primary">
                {t.rootInformation}: {root().name}
              </h2>
              <div class="flex flex-wrap gap-3">
                <StatusBadge tone="neutral" label={`${t.index}: ${root().indexEnabled ? t.on : t.off}`} />
                <StatusBadge tone="neutral" label={`${t.history}: ${root().versioningEnabled ? t.on : t.off}`} />
              </div>
              <dl class="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div>
                  <dt class="text-xs text-dimmed">{t.fileCount}</dt>
                  <dd class="text-sm">
                    <Format.Number value={root().files} fallback={t.unknown} />
                  </dd>
                </div>
                <div>
                  <dt class="text-xs text-dimmed">{t.folderCount}</dt>
                  <dd class="text-sm">
                    <Format.Number value={root().directories} fallback={t.unknown} />
                  </dd>
                </div>
                <div>
                  <dt class="text-xs text-dimmed">{t.storageBytes}</dt>
                  <dd class="text-sm">
                    <Format.Bytes value={root().bytes} fallback={t.unknown} />
                  </dd>
                </div>
              </dl>
              <p class="text-xs text-dimmed">{t.rootScope}</p>
            </Paper>
          )}
        </Show>
        <Settings configuration={result.configuration} availability={result.availability} />
      </div>
    </AdminLayout>
  );
});
