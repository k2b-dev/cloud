import type { LinkNavigateEvent } from "@k2b/ssr/nav";
import { mutation } from "@k2b/stdlib/solid";
import { Button, ButtonLink, Format, InlineGuidance, SettingsSection, StatCell, StatGrid, StatusBadge, type StatusTone } from "@k2b/ui";
import { createEffect, createSignal, For, Show } from "solid-js";
import { apiClient } from "../api/client";
import type { HomeProvisioningOverview, HomeProvisioningState, HomeProvisioningStatus } from "../contracts";
import AdminIssue from "./AdminIssue";
import { useAdminMessages } from "./admin-messages";

const WAITING = ["not_configured", "auto_create_off", "posix_incomplete"] as const;

/** Automatic personal directories of one storage area: what is done, what waits and why, and the way out. */
export default function HomeProvisioning(props: {
  overview: HomeProvisioningOverview;
  settingsHref: string;
  onNavigate: (event: LinkNavigateEvent) => void;
}) {
  const a = useAdminMessages();
  const count = (state: HomeProvisioningState) => props.overview.counts[state] ?? 0;
  const waiting = () => WAITING.reduce((sum, state) => sum + count(state), 0);
  // Further pages append below the first one from the snapshot; a new snapshot starts over.
  const [more, setMore] = createSignal<HomeProvisioningStatus[]>([]);
  const [cursor, setCursor] = createSignal(props.overview.nextCursor);
  createEffect(() => {
    setMore([]);
    setCursor(props.overview.nextCursor);
  });
  const load = mutation.create({
    mutation: async (after: string, { abortSignal }) => {
      const response = await apiClient.admin.provisioning.$get(
        { query: { area: props.overview.area, after } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(a().homesMoreFailed);
      const page = await response.json();
      setMore((items) => [...items, ...page.items.filter((item) => item.state !== "done")]);
      setCursor(page.nextCursor);
    },
  });
  const items = () => [...props.overview.items.filter((item) => item.state !== "done"), ...more()];
  const label = (state: HomeProvisioningState) =>
    ({
      not_configured: a().homesStateNotConfigured,
      auto_create_off: a().homesStateAutoCreateOff,
      posix_incomplete: a().homesStatePosix,
      failed: a().homesStateFailed,
      inactive: a().homesStateInactive,
      done: a().homesDone,
    })[state];
  const tone = (state: HomeProvisioningState): StatusTone => (state === "failed" ? "error" : state === "inactive" ? "neutral" : "warning");
  const settingsLink = () => (
    <ButtonLink size="sm" variant="secondary" href={props.settingsHref} navigation="enhanced" onNavigate={props.onNavigate}>
      {a().homesOpenSettings}
    </ButtonLink>
  );
  return (
    <SettingsSection title={a().homesTitle} subtitle={a().homesSubtitle} icon="ti ti-home">
      <div class="flex min-w-0 flex-col gap-4">
        <StatGrid columns={3}>
          <StatCell label={a().homesDone} value={<Format.Number value={count("done")} />} />
          <StatCell label={a().homesWaiting} value={<Format.Number value={waiting()} />} />
          <StatCell label={a().homesFailed} value={<Format.Number value={count("failed")} />} />
        </StatGrid>
        <Show when={count("not_configured") > 0}>
          <InlineGuidance tone="warning">
            <span class="flex flex-wrap items-center gap-3">
              <span>{a().homesWaitingNotConfigured}</span>
              {settingsLink()}
            </span>
          </InlineGuidance>
        </Show>
        <Show when={count("auto_create_off") > 0}>
          <InlineGuidance tone="warning">
            <span class="flex flex-wrap items-center gap-3">
              <span>{a().homesWaitingAutoCreateOff}</span>
              {settingsLink()}
            </span>
          </InlineGuidance>
        </Show>
        <Show when={count("posix_incomplete") > 0}>
          <InlineGuidance tone="warning">{a().homesWaitingPosix}</InlineGuidance>
        </Show>
        <Show when={count("failed") > 0}>
          <InlineGuidance tone="danger">{a().homesFailedHint}</InlineGuidance>
        </Show>
        <Show
          when={items().length > 0}
          fallback={<p class="text-sm text-secondary">{count("done") > 0 ? a().homesAllDone : a().homesNone}</p>}
        >
          <ul class="m-0 flex list-none flex-col gap-1 p-0" aria-label={a().homesWaiting}>
            <For each={items()}>
              {(item) => (
                <li class="flex min-w-0 flex-col gap-0.5 py-1.5">
                  <span class="flex min-w-0 items-center gap-3">
                    <span class="min-w-0 flex-1 truncate text-sm font-medium">{item.username ?? a().homesUnknownAccount}</span>
                    <StatusBadge tone={tone(item.state)} label={label(item.state)} />
                  </span>
                  <span class="text-xs text-dimmed">
                    <Format.DateTime value={item.updatedAt} />
                    <Show when={item.state === "failed" && item.errorCode}>
                      {" · "}
                      <AdminIssue code={item.errorCode} />
                    </Show>
                  </span>
                </li>
              )}
            </For>
          </ul>
          <Show when={load.error()}>
            <InlineGuidance role="alert" tone="danger">
              {load.error()?.message}
            </InlineGuidance>
          </Show>
          <Show when={cursor()}>
            {(after) => (
              <div>
                <Button size="sm" variant="secondary" loading={load.loading()} onClick={() => void load.mutate(after())}>
                  {a().homesMore}
                </Button>
              </div>
            )}
          </Show>
        </Show>
        <p class="text-xs text-dimmed" role="status">
          <Show when={!props.overview.reconcile.running} fallback={a().homesReconcileRunning}>
            <Show when={props.overview.reconcile.lastRunAt} fallback={a().homesReconcileNever}>
              {(at) => (
                <>
                  {a().homesReconcileLast}: <Format.DateTime value={at()} />
                  <Show when={props.overview.reconcile.lastResult}>
                    {(result) => (
                      <>
                        {" · "}
                        <Format.Number value={result().processed} /> {a().homesChecked}
                      </>
                    )}
                  </Show>
                </>
              )}
            </Show>
          </Show>
        </p>
      </div>
    </SettingsSection>
  );
}
