import { AppDevicesPageSchema, type AppDeviceView } from "@k2b/cloud/contracts";
import { dates } from "@k2b/stdlib";
import { useLocale } from "@k2b/ui";
import { type Action, Button, Dialog, Empty, Field, Input, Menu, Row, Section, type TwoActions, useToast } from "@k2b/ui/v2";
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type { z } from "zod";
import ApprovalNotice from "./ApprovalNotice";
import type { ApprovalAvailability } from "./availability";
import { approvalApi, approvalRequestOptions, checked, parsed } from "./client";
import ApprovalFeedback from "./Feedback";
import { useInstallApp } from "./InstallApp";
import { appApprovalMessages } from "./messages";
import Pairing from "./Pairing";
import RevokeDevice, { findRemoval, type RevokeRequest, revokeStorageKey, SavedRevokeSchema } from "./RevokeDevice";

// Mirrors the server's readable minute after a device change expires.
const removalResultGraceMs = 60_000;

/** At most two deeds for a section head. */
const two = (list: readonly Action[]): TwoActions | undefined => {
  const [first, second] = list;
  return first ? (second ? [first, second] : [first]) : undefined;
};

/** The paired sign-in app devices of the signed-in person, as a section of the security page. */
export default function DevicesSection(props: {
  initial: z.infer<typeof AppDevicesPageSchema> | null;
  availability: ApprovalAvailability;
  admin?: boolean;
  pairing?: { userId: string; name: string; appOrigin: string };
}) {
  const locale = useLocale();
  const t = () => appApprovalMessages.resolve([locale()]).t;
  const toast = useToast();
  const install = useInstallApp(() => props.pairing?.appOrigin ?? "");
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
                  toast(t().revokeCheckFailed, { status: "bad" });
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
      toast(t().saved, { status: "ok" });
    } catch (cause) {
      if (!disposed) setError(cause);
    } finally {
      if (!disposed) setBusy(false);
    }
  };
  const editingDevice = () => activeDevices().find((device) => device.id === editing());
  const deviceLine = (device: AppDeviceView) =>
    [
      device.assisted ? t().assisted : t().self,
      t().created({ date: dates.formatDateTime(device.createdAt, { locale: locale() }) }),
      device.lastUsedAt ? t().used({ date: dates.formatDateTime(device.lastUsedAt, { locale: locale() }) }) : t().never,
    ].join(" · ");
  return (
    <>
      <Section
        icon="device-mobile"
        title={t().devices}
        count={page() ? activeDevices().length : undefined}
        summary={t().description}
        actions={two([
          ...(props.pairing?.appOrigin ? [{ label: t().install, icon: "download", onClick: install.start }] : []),
          ...(props.availability === "configured"
            ? [{ label: t().pair, icon: "plus", disabled: !props.pairing, onClick: () => setPairingOpen(true) }]
            : []),
        ])}
        more={page()?.nextCursor ? { label: t().more, disabled: busy(), onClick: () => void load(true) } : undefined}
      >
        <Show when={props.availability !== "configured"}>
          <ApprovalNotice state={props.availability} admin={props.admin} settingsLink={props.admin} />
        </Show>
        <ApprovalFeedback error={error()} />
        <Show when={page()}>
          <Show
            when={activeDevices().length}
            fallback={
              <Show when={props.availability === "configured"}>
                <Empty icon="device-mobile" text={t().empty} />
              </Show>
            }
          >
            <For each={activeDevices()}>
              {(device) => (
                <Row
                  icon="device-mobile"
                  lines={[device.name, deviceLine(device)]}
                  end={
                    <Menu
                      label={t().deviceActions({ name: device.name })}
                      disabled={busy()}
                      items={[
                        {
                          label: t().rename,
                          icon: "pencil",
                          onClick: () => {
                            setEditing(device.id);
                            setName(device.name);
                          },
                        },
                        // Revoking needs approval on a paired device, which only a configured Cloud can ask for.
                        ...(props.pairing
                          ? [{ label: t().revoke, icon: "device-mobile-off", danger: true, onClick: () => setRevoking({ device }) }]
                          : []),
                      ]}
                    />
                  }
                />
              )}
            </For>
          </Show>
        </Show>
      </Section>
      <Dialog
        title={t().rename}
        open={editingDevice() !== undefined}
        onOpenChange={(open) => {
          if (!open && !busy()) setEditing(undefined);
        }}
        foot={
          <>
            <Button disabled={busy()} onClick={() => setEditing(undefined)}>
              {t().back}
            </Button>
            <Button
              variant="primary"
              busy={busy()}
              disabled={!name().trim()}
              onClick={() => {
                const device = editingDevice();
                if (device) void rename(device);
              }}
            >
              {t().save}
            </Button>
          </>
        }
      >
        {/* k2b-ui gap: Input has no maxLength; the server refuses names over 80 characters. */}
        <Field name="name" label={t().name} required>
          <Input value={name()} onInput={setName} />
        </Field>
      </Dialog>
      {install.dialog()}
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
    </>
  );
}
