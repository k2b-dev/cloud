import { apiClient } from "@k2b/cloud/clients/core";
import {
  PWA_LIMITS,
  PwaDeviceListSchema,
  type PwaDeviceView,
  PwaPairingStartResultSchema,
  PwaPairingStatusSchema,
  pairingLink,
} from "@k2b/cloud/contracts";
import { type DateContext, dates } from "@k2b/stdlib";
import { qr } from "@k2b/stdlib/qr";
import { Button, NoticeCard, PinInput, Placeholder, prompts, SettingsSection, toast, useLocale } from "@k2b/ui";
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { z } from "zod";
import { ApprovalError, approvalRequestOptions, checked, parsed, pollApproval } from "../app-approval/client";
import { accountMessages } from "./messages";

const pwaApi = apiClient.auth.pwa.v1;
const ResumeSchema = z.object({ id: z.string().uuid(), expiresAt: z.string().datetime() });
type Status = z.infer<typeof PwaPairingStatusSchema>;
type Panel =
  | { kind: "closed" }
  | { kind: "starting" }
  | { kind: "waiting"; id: string; expiresAt: string; link: string | null; claimUntil: string | null; status: Status | null }
  | { kind: "done" | "expired" | "cancelled" | "reauthenticate" }
  | { kind: "error"; code: string };

const icon = (platform: PwaDeviceView["platform"]) =>
  platform === "ios" ? "ti ti-brand-apple" : platform === "android" ? "ti ti-brand-android" : "ti ti-device-mobile";

/** The pairing panel and the list of paired phones on `/me/app`. SSR renders the list; pairing needs the browser. */
export default function AppDevices(props: { userId: string; initial: PwaDeviceView[]; dateConfig: DateContext }) {
  const locale = useLocale();
  const t = () => accountMessages.resolve([locale()]).t;
  const [devices, setDevices] = createSignal(props.initial);
  const [panel, setPanel] = createSignal<Panel>({ kind: "closed" });
  const [code, setCode] = createSignal("");
  const [wrongCode, setWrongCode] = createSignal<number>();
  const [busy, setBusy] = createSignal(false);
  const [removing, setRemoving] = createSignal<string>();
  const [now, setNow] = createSignal(Date.now());
  const [showQr, setShowQr] = createSignal(false);
  const storageKey = `cloud.pwa-pairing:${props.userId}`;
  let stop = () => {};
  let stopCompletion = () => {};
  let disposed = false;

  const remember = (value: z.infer<typeof ResumeSchema> | null) => {
    try {
      if (value) window.sessionStorage.setItem(storageKey, JSON.stringify(value));
      else window.sessionStorage.removeItem(storageKey);
    } catch {}
  };
  const finish = (kind: "done" | "expired" | "cancelled" | "reauthenticate" | "closed") => {
    stop();
    remember(null);
    setCode("");
    setWrongCode(undefined);
    setPanel({ kind });
  };
  const fail = (cause: unknown) => {
    if (cause instanceof ApprovalError && cause.code === "REAUTHENTICATE") return finish("reauthenticate");
    if (cause instanceof ApprovalError && cause.code === "EXPIRED") return finish("expired");
    if (cause instanceof ApprovalError && cause.code === "NOT_FOUND") return finish("expired");
    stop();
    remember(null);
    setPanel({ kind: "error", code: cause instanceof ApprovalError ? cause.code : "UNKNOWN" });
  };

  const reload = async () => {
    try {
      const list = await parsed(await pwaApi.devices.$get(undefined, approvalRequestOptions()), PwaDeviceListSchema);
      if (!disposed) setDevices(list.items);
    } catch {}
  };

  /**
   * After the code is confirmed the phone still has to complete: only then does its device exist.
   * Keep reading the pairing until then, so the list shows the new phone without a reload.
   */
  const awaitCompletion = (id: string, expiresAt: string) => {
    finish("done");
    stopCompletion();
    stopCompletion = pollApproval(
      async (signal) => {
        if (Date.parse(expiresAt) <= Date.now()) {
          void reload();
          return false;
        }
        const status = await parsed(
          await pwaApi.pairings[":id"].$get({ param: { id } }, approvalRequestOptions(signal)),
          PwaPairingStatusSchema,
        );
        if (signal.aborted || disposed) return false;
        if (status.state === "confirmed") return true;
        void reload();
        return false;
      },
      (cause) => {
        if (cause instanceof ApprovalError && cause.status < 500 && cause.status !== 429) {
          void reload();
          return false;
        }
        return true;
      },
      PWA_LIMITS.pollSeconds,
    );
  };

  /** `resumed`: read at once after a reload instead of one poll interval later. */
  const watch = (id: string, expiresAt: string, resumed = false) => {
    stop();
    stop = pollApproval(
      async (signal) => {
        if (Date.parse(expiresAt) <= Date.now()) {
          finish("expired");
          return false;
        }
        const status = await parsed(
          await pwaApi.pairings[":id"].$get({ param: { id } }, approvalRequestOptions(signal)),
          PwaPairingStatusSchema,
        );
        if (signal.aborted || disposed) return false;
        if (status.state === "completed") {
          finish("done");
          void reload();
          return false;
        }
        if (status.state === "confirmed") {
          awaitCompletion(id, expiresAt);
          return false;
        }
        if (status.state === "cancelled") {
          finish(status.attemptsLeft === 0 ? "expired" : "cancelled");
          return false;
        }
        setPanel((current) => (current.kind === "waiting" && current.id === id ? { ...current, status } : current));
        return true;
      },
      (cause) => {
        // Server and network failures keep polling; answers about the pairing end it.
        if (cause instanceof ApprovalError && cause.status < 500 && cause.status !== 429) {
          fail(cause);
          return false;
        }
        return true;
      },
      PWA_LIMITS.pollSeconds,
      { immediate: resumed },
    );
  };

  const start = async () => {
    if (busy()) return;
    setBusy(true);
    setPanel({ kind: "starting" });
    try {
      const result = await parsed(await pwaApi.pairings.$post(undefined, approvalRequestOptions()), PwaPairingStartResultSchema);
      if (disposed) return;
      remember({ id: result.id, expiresAt: result.expiresAt });
      setPanel({
        kind: "waiting",
        id: result.id,
        expiresAt: result.expiresAt,
        link: pairingLink(window.location.origin, result.secret),
        claimUntil: result.claimUntil,
        status: null,
      });
      watch(result.id, result.expiresAt);
    } catch (cause) {
      if (!disposed) fail(cause);
    } finally {
      if (!disposed) setBusy(false);
    }
  };

  const confirm = async () => {
    const current = panel();
    if (current.kind !== "waiting" || busy() || code().length !== 6) return;
    setBusy(true);
    try {
      await checked(
        await pwaApi.pairings[":id"].confirm.$post({ param: { id: current.id }, json: { code: code() } }, approvalRequestOptions()),
      );
      if (!disposed) awaitCompletion(current.id, current.expiresAt);
    } catch (cause) {
      if (disposed) return;
      if (cause instanceof ApprovalError && cause.code === "WRONG_CODE") {
        const attemptsLeft = Math.max(0, (current.status?.attemptsLeft ?? PWA_LIMITS.confirmAttempts) - 1);
        setCode("");
        setWrongCode(attemptsLeft);
        setPanel({ ...current, status: current.status ? { ...current.status, attemptsLeft } : null });
      } else fail(cause);
    } finally {
      if (!disposed) setBusy(false);
    }
  };

  const cancel = async () => {
    const current = panel();
    if (current.kind !== "waiting") return finish("closed");
    stop();
    setBusy(true);
    try {
      await checked(await pwaApi.pairings[":id"].cancel.$post({ param: { id: current.id } }, approvalRequestOptions()));
      if (!disposed) finish("cancelled");
    } catch (cause) {
      if (!disposed) fail(cause);
    } finally {
      if (!disposed) setBusy(false);
    }
  };

  const copy = async () => {
    const current = panel();
    if (current.kind !== "waiting" || !current.link) return;
    try {
      await navigator.clipboard.writeText(current.link);
      toast.success(t().pwaLinkCopied);
    } catch {
      toast.error(t().pwaCopyFailed);
    }
  };

  const remove = async (device: PwaDeviceView) => {
    if (removing()) return;
    const accepted = await prompts.confirm(t().pwaRemoveConfirm({ name: device.name }), {
      title: t().pwaRemoveTitle,
      variant: "danger",
      confirmText: t().pwaRemove,
    });
    if (!accepted || disposed) return;
    setRemoving(device.id);
    try {
      await checked(await pwaApi.devices[":id"].$delete({ param: { id: device.id } }, approvalRequestOptions()));
      if (disposed) return;
      setDevices((items) => items.filter((item) => item.id !== device.id));
      toast.success(t().pwaRemoved);
    } catch {
      if (!disposed) toast.error(t().pwaFailed);
    } finally {
      if (!disposed) setRemoving(undefined);
    }
  };

  const reauthenticate = () => {
    remember(null);
    const target = new URL("/me/app", window.location.origin);
    target.searchParams.set("pair", "1");
    target.searchParams.set("reauthenticate", "1");
    window.location.assign(`/auth/login?${new URLSearchParams({ redirectTo: target.pathname + target.search, credential: "legacy" })}`);
  };

  onMount(() => {
    setShowQr(window.matchMedia("(pointer: fine)").matches);
    const timer = setInterval(() => setNow(Date.now()), 1000);
    onCleanup(() => clearInterval(timer));
    const url = new URL(window.location.href);
    const requested = url.searchParams.get("pair") === "1";
    if (requested) {
      url.searchParams.delete("pair");
      url.searchParams.delete("reauthenticate");
      window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
    }
    try {
      const saved = ResumeSchema.safeParse(JSON.parse(window.sessionStorage.getItem(storageKey) || "null"));
      if (saved.success && Date.parse(saved.data.expiresAt) > Date.now()) {
        setPanel({ kind: "waiting", id: saved.data.id, expiresAt: saved.data.expiresAt, link: null, claimUntil: null, status: null });
        watch(saved.data.id, saved.data.expiresAt, true);
        return;
      }
      remember(null);
    } catch {
      remember(null);
    }
    if (requested) void start();
  });
  onCleanup(() => {
    disposed = true;
    stop();
    stopCompletion();
  });

  const remaining = (until: string) => {
    const seconds = Math.max(0, Math.ceil((Date.parse(until) - now()) / 1000));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  };
  const day = (value: string) => {
    const context = { ...props.dateConfig, locale: locale() };
    if (dates.isToday(new Date(value), context)) return t().pwaToday;
    if (dates.isToday(new Date(Date.parse(value) + 86_400_000), context)) return t().pwaYesterday;
    return dates.formatDate(value, context);
  };
  const waiting = () => {
    const current = panel();
    return current.kind === "waiting" ? current : null;
  };
  const claimed = () => waiting()?.status?.state === "claimed";
  const failure = () => {
    const current = panel();
    return current.kind === "error" ? current : null;
  };
  const errorText = (code: string) =>
    code === "LIMIT_REACHED" ? t().pwaLimit : code === "UNAVAILABLE" ? t().pwaUnavailable : t().pwaFailed;

  return (
    <>
      <SettingsSection
        title={t().pwaPair}
        subtitle={t().pwaPairHint}
        actions={
          <Show when={panel().kind === "closed" || panel().kind === "done" || panel().kind === "expired" || panel().kind === "cancelled"}>
            <Button onClick={start} loading={busy()}>
              <i class="ti ti-qrcode" aria-hidden="true" />
              {t().pwaPair}
            </Button>
          </Show>
        }
      >
        {/* Closed, the section is only its heading and button; each state announces itself through its role. */}
        <Show when={panel().kind !== "closed"}>
          <div class="flex flex-col gap-4">
            <Show when={panel().kind === "starting"}>
              <Placeholder state="loading" title={t().pwaPair} />
            </Show>
            <Show when={panel().kind === "done"}>
              <NoticeCard tone="success">
                <p role="status">{t().pwaPaired}</p>
              </NoticeCard>
            </Show>
            <Show when={panel().kind === "expired"}>
              <p class="text-sm text-dimmed" role="status">
                {t().pwaExpired}
              </p>
            </Show>
            <Show when={panel().kind === "cancelled"}>
              <p class="text-sm text-dimmed" role="status">
                {t().pwaCancelled}
              </p>
            </Show>
            <Show when={panel().kind === "reauthenticate"}>
              <NoticeCard tone="warning">
                <div class="flex flex-col items-start gap-2">
                  <p role="status">{t().pwaReauthenticateHint}</p>
                  <Button variant="secondary" onClick={reauthenticate}>
                    {t().pwaReauthenticate}
                  </Button>
                </div>
              </NoticeCard>
            </Show>
            <Show when={failure()}>
              {(current) => (
                <NoticeCard tone="danger">
                  <div role="alert" class="flex flex-col items-start gap-2">
                    <p>{errorText(current().code)}</p>
                    <Button variant="secondary" onClick={start} loading={busy()}>
                      {t().pwaRetry}
                    </Button>
                  </div>
                </NoticeCard>
              )}
            </Show>
            <Show when={waiting()}>
              {(current) => (
                <div class="flex flex-col gap-4">
                  <Show
                    when={claimed()}
                    fallback={
                      <Show when={current().link} fallback={<p class="text-sm text-dimmed">{t().pwaResumed}</p>}>
                        {(link) => (
                          <div class="flex flex-col items-center gap-3">
                            <Show when={showQr()}>
                              <img
                                class="w-56 max-w-full rounded-[var(--ui-radius-control)] bg-white p-2"
                                alt={t().pwaQrLabel}
                                src={`data:image/svg+xml,${encodeURIComponent(qr.toSvg(link()))}`}
                              />
                            </Show>
                            <Show when={current().claimUntil}>
                              {(until) => <p class="text-xs text-dimmed tabular-nums">{t().pwaLinkValid({ time: remaining(until()) })}</p>}
                            </Show>
                            <Button variant="secondary" onClick={copy}>
                              <i class="ti ti-copy" aria-hidden="true" />
                              {t().pwaCopyLink}
                            </Button>
                          </div>
                        )}
                      </Show>
                    }
                  >
                    <form
                      class="flex flex-col gap-3"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void confirm();
                      }}
                    >
                      <p class="text-sm">{t().pwaClaimed({ name: current().status?.device?.name ?? "" })}</p>
                      <PinInput label={t().pwaCode} length={6} value={code} onValueChange={setCode} onSubmit={confirm} disabled={busy()} />
                      <Show when={wrongCode() !== undefined}>
                        <p class="text-sm text-[var(--ui-danger-text)]" role="alert">
                          {t().pwaWrongCode({ count: wrongCode() ?? 0 })}
                        </p>
                      </Show>
                      <div class="flex flex-wrap gap-2">
                        <Button type="submit" loading={busy()} disabled={code().length !== 6}>
                          {t().pwaConfirm}
                        </Button>
                      </div>
                    </form>
                  </Show>
                  <div>
                    <Button variant="ghost" onClick={cancel} disabled={busy()}>
                      {t().pwaCancel}
                    </Button>
                  </div>
                </div>
              )}
            </Show>
          </div>
        </Show>
      </SettingsSection>

      <SettingsSection title={t().pwaPhones}>
        <Show when={devices().length} fallback={<p class="text-sm text-dimmed">{t().pwaNoPhones}</p>}>
          <ul class="flex flex-col divide-y divide-[var(--ui-border)]">
            <For each={devices()}>
              {(device) => (
                <li class="flex items-center gap-3 py-3">
                  <i class={`${icon(device.platform)} text-lg text-dimmed`} aria-hidden="true" />
                  <div class="min-w-0 flex-1">
                    <p class="flex flex-wrap items-center gap-2 break-words font-medium">
                      {device.name}
                      <Show when={device.current}>
                        <span class="tag tag-neutral">{t().pwaThisPhone}</span>
                      </Show>
                    </p>
                    <p class="text-xs text-dimmed">
                      {t().pwaPairedOn({ date: dates.formatDate(device.createdAt, { ...props.dateConfig, locale: locale() }) })} ·{" "}
                      {t().pwaLastUsed({ when: day(device.lastUsedAt) })}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={removing() === device.id}
                    disabled={Boolean(removing())}
                    onClick={() => remove(device)}
                  >
                    {t().pwaRemove}
                  </Button>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </SettingsSection>
    </>
  );
}
