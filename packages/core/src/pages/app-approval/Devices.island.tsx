import { dates } from "@k2b/stdlib";
import { Button, Placeholder, prompts, TextInput, toast, useLocale } from "@k2b/ui";
import { AppDevicesPageSchema, type AppDeviceView } from "@k2b/cloud/contracts";
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type { z } from "zod";
import { approvalApi, approvalRequestOptions, checked, parsed } from "./client";
import ApprovalFeedback from "./Feedback";
import { appApprovalMessages } from "./messages";
import ApprovalStatus from "./ApprovalStatus";
import type { ApprovalAvailability } from "./availability";
import Pairing from "./Pairing";
import InstallApp from "./InstallApp";

export default function Devices(props: {
  initial: z.infer<typeof AppDevicesPageSchema> | null;
  availability: ApprovalAvailability;
  admin?: boolean;
  pairing?: { userId: string; name: string; appOrigin: string };
}) {
  const locale = useLocale();
  const t = () => appApprovalMessages.resolve([locale()]).t;
  const [page, setPage] = createSignal(props.initial);
  const activeDevices = createMemo(() => page()?.items.filter((device) => !device.revokedAt) ?? []);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<unknown>(props.initial ? undefined : new Error());
  const [editing, setEditing] = createSignal<string>();
  const [name, setName] = createSignal("");
  const [pairingOpen, setPairingOpen] = createSignal(false);
  onMount(() => {
    const url = new URL(window.location.href);
    const requestedUser = url.searchParams.get("pairDevice");
    if (!requestedUser) return;
    url.searchParams.delete("pairDevice");
    url.searchParams.delete("reauthenticate");
    window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
    if (props.availability === "configured" && requestedUser === props.pairing?.userId) {
      try {
        window.sessionStorage.removeItem(`cloud.app-pairing:${requestedUser}:${requestedUser}`);
      } catch {}
      setPairingOpen(true);
    }
  });
  let disposed = false;
  onCleanup(() => {
    disposed = true;
  });
  const load = async (more = false) => {
    if (busy()) return;
    setBusy(true);
    setError(undefined);
    try {
      const next = await parsed(
        await approvalApi.manage.devices.$get(
          { query: { after: more ? (page()?.nextCursor ?? undefined) : undefined } },
          approvalRequestOptions(),
        ),
        AppDevicesPageSchema,
      );
      if (!disposed) setPage({ items: more ? [...(page()?.items ?? []), ...next.items] : next.items, nextCursor: next.nextCursor });
    } catch (cause) {
      if (!disposed) setError(cause);
    } finally {
      if (!disposed) setBusy(false);
    }
  };
  const update = async (device: AppDeviceView, rename: boolean) => {
    if (busy()) return;
    setBusy(true);
    setError(undefined);
    try {
      if (
        !rename &&
        !(await prompts.confirm(t().revokeConfirm({ name: device.name }), {
          title: t().revoke,
          variant: "danger",
          confirmText: t().revoke,
        }))
      )
        return;
      if (disposed) return;
      await checked(
        await approvalApi.manage.devices.update.$post(
          {
            json: rename ? { operation: "rename", deviceId: device.id, name: name().trim() } : { operation: "revoke", deviceId: device.id },
          },
          approvalRequestOptions(),
        ),
      );
      if (disposed) return;
      setEditing(undefined);
      setPage((previous) =>
        previous
          ? {
              ...previous,
              items: previous.items.map((item) =>
                item.id === device.id
                  ? { ...item, ...(rename ? { name: name().trim() } : { revokedAt: item.revokedAt ?? new Date().toISOString() }) }
                  : item,
              ),
            }
          : previous,
      );
      toast.success(t().saved);
    } catch (cause) {
      if (!disposed) setError(cause);
    } finally {
      if (!disposed) setBusy(false);
    }
  };
  return (
    <section class="paper flex flex-col gap-4 p-5">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 class="text-sm font-semibold">{t().devices}</h2>
          <p class="mt-1 text-xs text-dimmed">{t().description}</p>
        </div>
        <div class="flex flex-wrap gap-2">
          <Show when={props.pairing?.appOrigin}>{(origin) => <InstallApp origin={origin()} />}</Show>
          <Show when={props.availability === "configured"}>
            <Button size="sm" disabled={!props.pairing} onClick={() => setPairingOpen(true)}>
              {t().pair}
            </Button>
          </Show>
        </div>
      </div>
      <Show when={pairingOpen() && props.pairing}>
        {(pairing) => (
          <Pairing
            {...pairing()}
              actorId={pairing().userId}
            returnTo="/me/security"
            onClose={() => {
              setPairingOpen(false);
              void load();
            }}
          />
        )}
      </Show>
      <Show when={props.availability !== "configured"}>
        <ApprovalStatus state={props.availability} admin={props.admin} settingsLink={props.admin} />
      </Show>
      <ApprovalFeedback error={error()} />
      <Show when={page()}>
        {(data) => (
          <>
            <Show
              when={activeDevices().length}
              fallback={
                <Show when={props.availability === "configured"}>
                  <Placeholder icon="ti ti-device-mobile" description={t().empty} />
                </Show>
              }
            >
              <div class="divide-y divide-[var(--k2b-border)]">
                <For each={activeDevices()}>
                  {(device) => (
                    <div class="flex flex-wrap items-start justify-between gap-3 py-3">
                      <div class="min-w-0">
                        <p class="break-words font-medium">{device.name}</p>
                        <p class="text-xs text-dimmed">{device.assisted ? t().assisted : t().self}</p>
                        <p class="text-xs text-dimmed">
                          {t().created({ date: dates.formatDateTime(device.createdAt, { locale: locale() }) })}
                        </p>
                        <p class="text-xs text-dimmed">
                          {device.lastUsedAt
                            ? t().used({ date: dates.formatDateTime(device.lastUsedAt, { locale: locale() }) })
                            : t().never}
                        </p>
                        <Show when={device.revokedAt}>
                          {(date) => (
                            <p class="text-xs text-dimmed">{t().revokedAt({ date: dates.formatDateTime(date(), { locale: locale() }) })}</p>
                          )}
                        </Show>
                      </div>
                      <Show when={!device.revokedAt}>
                        <div class="flex flex-wrap gap-2">
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={busy()}
                            onClick={() => {
                              setEditing(device.id);
                              setName(device.name);
                            }}
                          >
                            {t().rename}
                          </Button>
                          <Button size="sm" variant="secondary" disabled={busy()} onClick={() => update(device, false)}>
                            {t().revoke}
                          </Button>
                        </div>
                      </Show>
                      <Show when={editing() === device.id}>
                        <form
                          class="flex w-full flex-wrap items-end gap-2"
                          onSubmit={(event) => {
                            event.preventDefault();
                            void update(device, true);
                          }}
                        >
                          <TextInput label={t().name} value={name} onValueChange={setName} required maxLength={80} />
                          <Button type="submit" size="sm" disabled={busy() || !name().trim()}>
                            {t().save}
                          </Button>
                          <Button type="button" size="sm" variant="ghost" disabled={busy()} onClick={() => setEditing(undefined)}>
                            {t().back}
                          </Button>
                        </form>
                      </Show>
                    </div>
                  )}
                </For>
              </div>
            </Show>
            <Show when={data().nextCursor}>
              <Button variant="secondary" loading={busy()} onClick={() => load(true)}>
                {t().more}
              </Button>
            </Show>
          </>
        )}
      </Show>
    </section>
  );
}
