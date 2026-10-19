import { AppDevicesPageSchema, type AppDeviceView } from "@k2b/cloud/contracts";
import { dates } from "@k2b/stdlib";
import { Button, Placeholder, SettingsSection, TextInput, toast, useLocale } from "@k2b/ui";
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type { z } from "zod";
import ApprovalStatus from "./ApprovalStatus";
import type { ApprovalAvailability } from "./availability";
import { approvalApi, approvalRequestOptions, checked, parsed } from "./client";
import ApprovalFeedback from "./Feedback";
import InstallApp from "./InstallApp";
import { appApprovalMessages } from "./messages";
import Pairing from "./Pairing";
import RevokeDevice, { findRemoval, type RevokeRequest, revokeStorageKey, SavedRevokeSchema } from "./RevokeDevice";

// Mirrors the server's readable minute after a device change expires.
const removalResultGraceMs = 60_000;

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
  const [revoking, setRevoking] = createSignal<{ device: Pick<AppDeviceView, "id" | "name">; resume?: RevokeRequest }>();
  onMount(() => {
    // A revocation that was still waiting for approval continues after a reload of this tab.
    const userId = props.pairing?.userId;
    if (userId && props.availability === "configured") {
      try {
        const raw = window.sessionStorage.getItem(revokeStorageKey(userId));
        const saved = SavedRevokeSchema.safeParse(JSON.parse(raw || "null"));
        const forget = () => window.sessionStorage.removeItem(revokeStorageKey(userId));
        // A newer removal saves its own record meanwhile; a late lookup answer then leaves it alone.
        const unchanged = () => {
          try {
            return window.sessionStorage.getItem(revokeStorageKey(userId)) === raw;
          } catch {
            return false;
          }
        };
        if (!saved.success || Date.now() >= Date.parse(saved.data.expiresAt) + removalResultGraceMs) forget();
        else {
          const { changeId, ...unsure } = saved.data;
          const resume = (request: RevokeRequest) => setRevoking({ device: { id: request.deviceId, name: request.name }, resume: request });
          if (changeId) resume({ ...unsure, changeId });
          // The answer to the last send was lost: open the dialog only if Cloud holds a request of this session. A send
          // held up in Cloud may still commit after an empty lookup, so the record stays until it expires and the next
          // reload looks again.
          else {
            // A failed lookup keeps the record, says so, and tries again once the connection is back.
            const look = () =>
              void findRemoval(unsure).then(
                (found) => {
                  if (!unchanged()) return;
                  if (found) resume(found);
                },
                () => {
                  if (!unchanged()) return;
                  toast.error(t().revokeCheckFailed);
                  window.addEventListener("online", look, { once: true });
                },
              );
            look();
          }
        }
      } catch {}
    }
  });
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
  const rename = async (device: AppDeviceView) => {
    if (busy()) return;
    setBusy(true);
    setError(undefined);
    try {
      await checked(
        await approvalApi.manage.devices.update.$post(
          { json: { operation: "rename", deviceId: device.id, name: name().trim() } },
          approvalRequestOptions(),
        ),
      );
      if (disposed) return;
      setEditing(undefined);
      setPage((previous) =>
        previous
          ? { ...previous, items: previous.items.map((item) => (item.id === device.id ? { ...item, name: name().trim() } : item)) }
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
    <SettingsSection
      title={t().devices}
      subtitle={t().description}
      actions={
        <>
          <Show when={props.pairing?.appOrigin}>{(origin) => <InstallApp origin={origin()} />}</Show>
          <Show when={props.availability === "configured"}>
            <Button size="sm" disabled={!props.pairing} onClick={() => setPairingOpen(true)}>
              {t().pair}
            </Button>
          </Show>
        </>
      }
    >
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
      <Show when={revoking()}>
        {(current) => (
          <Show when={props.pairing}>
            {(pairing) => (
              <RevokeDevice
                userId={pairing().userId}
                device={current().device}
                resume={current().resume}
                onClose={() => {
                  setRevoking(undefined);
                  void load();
                }}
              />
            )}
          </Show>
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
              <div class="flex flex-col gap-1 rounded-[var(--ui-radius-surface)] bg-[var(--ui-surface-subtle)] p-2">
                <For each={activeDevices()}>
                  {(device) => (
                    <div class="flex flex-wrap items-start justify-between gap-3 p-3">
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
                          {/* Revoking needs approval on a paired device, which only a configured Cloud can ask for. */}
                          <Show when={props.pairing}>
                            <Button size="sm" variant="secondary" disabled={busy()} onClick={() => setRevoking({ device })}>
                              {t().revoke}
                            </Button>
                          </Show>
                        </div>
                      </Show>
                      <Show when={editing() === device.id}>
                        <form
                          class="flex w-full flex-wrap items-end gap-2"
                          onSubmit={(event) => {
                            event.preventDefault();
                            void rename(device);
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
    </SettingsSection>
  );
}
