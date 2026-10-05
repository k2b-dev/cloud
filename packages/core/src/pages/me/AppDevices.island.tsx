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
import {
  announce,
  Button,
  ButtonLink,
  dialogCore,
  PanelDialog,
  PinInput,
  panelDialogFixedOptions,
  prompts,
  SettingsSection,
  toast,
  useLocale,
} from "@k2b/ui";
import { createEffect, createMemo, createSignal, For, Match, on, onCleanup, onMount, Show, Switch } from "solid-js";
import { z } from "zod";
import { ApprovalError, approvalRequestOptions, checked, parsed, pollApproval } from "../app-approval/client";
import { accountMessages } from "./messages";

const pwaApi = apiClient.auth.pwa.v1;
const ResumeSchema = z.object({ id: z.string().uuid(), expiresAt: z.string().datetime() });
type Status = z.infer<typeof PwaPairingStatusSchema>;
type Waiting = { kind: "waiting"; id: string; expiresAt: string; link: string | null; claimUntil: string | null; status: Status | null };
type Pairing =
  | { kind: "starting" }
  | Waiting
  | { kind: "done"; name: string }
  | { kind: "expired" | "locked" | "cancelled" | "reauthenticate" }
  | { kind: "error"; code: string };

const toneClass = {
  success: "text-[var(--k2b-success-text)]",
  warning: "text-[var(--k2b-warning-text)]",
  danger: "text-[var(--k2b-danger-text)]",
} as const;

const icon = (platform: PwaDeviceView["platform"]) =>
  platform === "ios" ? "ti ti-brand-apple" : platform === "android" ? "ti ti-brand-android" : "ti ti-device-mobile";

/**
 * The paired phones on `/me/app` and the pairing dialog. SSR renders the list; pairing needs the browser.
 * The whole pairing runs in one dialog of fixed height, so no step moves the page or the frame; closing it
 * cancels an open pairing.
 */
export default function AppDevices(props: { userId: string; initial: PwaDeviceView[]; dateConfig: DateContext }) {
  const locale = useLocale();
  const t = () => accountMessages.resolve([locale()]).t;
  const [devices, setDevices] = createSignal(props.initial);
  const [pairing, setPairing] = createSignal<Pairing>({ kind: "starting" });
  const [code, setCode] = createSignal("");
  const [wrongCode, setWrongCode] = createSignal<number>();
  const [busy, setBusy] = createSignal(false);
  const [removing, setRemoving] = createSignal<string>();
  const [now, setNow] = createSignal(Date.now());
  // Decided when the dialog opens, so its body never swaps after the first paint.
  const [showQr, setShowQr] = createSignal(true);
  const storageKey = `cloud.pwa-pairing:${props.userId}`;
  let stop = () => {};
  let stopCompletion = () => {};
  let closeDialog: (() => void) | undefined;
  let dialogBody: HTMLDivElement | undefined;
  let disposed = false;
  // Counts closed dialogs: an answer that arrives after its dialog closed changes nothing.
  let generation = 0;

  const remember = (value: z.infer<typeof ResumeSchema> | null) => {
    try {
      if (value) window.sessionStorage.setItem(storageKey, JSON.stringify(value));
      else window.sessionStorage.removeItem(storageKey);
    } catch {}
  };
  const finish = (next: Exclude<Pairing, { kind: "starting" } | Waiting>) => {
    stop();
    remember(null);
    setCode("");
    setWrongCode(undefined);
    setPairing(next);
  };
  const fail = (cause: unknown) => {
    if (cause instanceof ApprovalError && cause.code === "REAUTHENTICATE") return finish({ kind: "reauthenticate" });
    if (cause instanceof ApprovalError && (cause.code === "EXPIRED" || cause.code === "NOT_FOUND")) return finish({ kind: "expired" });
    finish({ kind: "error", code: cause instanceof ApprovalError ? cause.code : "UNKNOWN" });
  };

  const reload = async () => {
    try {
      const list = await parsed(await pwaApi.devices.$get(undefined, approvalRequestOptions()), PwaDeviceListSchema);
      if (!disposed) setDevices(list.items);
    } catch {}
  };

  /**
   * After the code is confirmed the phone still has to complete: only then does its device exist.
   * Keep reading the pairing until then, also after the dialog closed, so the list shows the new phone without a reload.
   */
  const awaitCompletion = (id: string, expiresAt: string, name: string) => {
    finish({ kind: "done", name });
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
          finish({ kind: "expired" });
          return false;
        }
        const status = await parsed(
          await pwaApi.pairings[":id"].$get({ param: { id } }, approvalRequestOptions(signal)),
          PwaPairingStatusSchema,
        );
        if (signal.aborted || disposed) return false;
        const name = status.device?.name ?? "";
        if (status.state === "completed") {
          finish({ kind: "done", name });
          void reload();
          return false;
        }
        if (status.state === "confirmed") {
          awaitCompletion(id, expiresAt, name);
          return false;
        }
        if (status.state === "cancelled") {
          finish({ kind: status.attemptsLeft === 0 ? "locked" : "cancelled" });
          return false;
        }
        setPairing((current) => (current.kind === "waiting" && current.id === id ? { ...current, status } : current));
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
    const run = generation;
    setBusy(true);
    setCode("");
    setWrongCode(undefined);
    setPairing({ kind: "starting" });
    try {
      const result = await parsed(await pwaApi.pairings.$post(undefined, approvalRequestOptions()), PwaPairingStartResultSchema);
      if (disposed || run !== generation) {
        // The dialog closed while the pairing started: nobody can enter its code.
        void cancelPending(result.id);
        return;
      }
      remember({ id: result.id, expiresAt: result.expiresAt });
      setPairing({
        kind: "waiting",
        id: result.id,
        expiresAt: result.expiresAt,
        link: pairingLink(window.location.origin, result.secret),
        claimUntil: result.claimUntil,
        status: null,
      });
      watch(result.id, result.expiresAt);
    } catch (cause) {
      if (!disposed && run === generation) fail(cause);
    } finally {
      if (!disposed && run === generation) setBusy(false);
    }
  };

  const confirm = async () => {
    const current = pairing();
    if (current.kind !== "waiting" || busy() || code().length !== 6) return;
    const run = generation;
    setBusy(true);
    try {
      await checked(
        await pwaApi.pairings[":id"].confirm.$post({ param: { id: current.id }, json: { code: code() } }, approvalRequestOptions()),
      );
      if (!disposed && run === generation) awaitCompletion(current.id, current.expiresAt, current.status?.device?.name ?? "");
    } catch (cause) {
      if (disposed || run !== generation) return;
      if (cause instanceof ApprovalError && cause.code === "WRONG_CODE") {
        const left = Math.max(0, (current.status?.attemptsLeft ?? PWA_LIMITS.confirmAttempts) - 1);
        setCode("");
        setWrongCode(left);
        setPairing({ ...current, status: current.status ? { ...current.status, attemptsLeft: left } : null });
        focusTarget()?.focus();
      } else if (cause instanceof ApprovalError && cause.code === "EXPIRED" && cause.attemptsLeft === 0) {
        // The last wrong code cancels the pairing on the server, which says so; any other end is an expiry.
        finish({ kind: "locked" });
      } else if (!(cause instanceof ApprovalError) || cause.status >= 500 || cause.status === 429) {
        // No answer about the code: the pairing stays open, so the same code can be sent again.
        toast.error(t().pwaFailed);
      } else fail(cause);
    } finally {
      if (!disposed && run === generation) setBusy(false);
    }
  };

  const cancelPending = async (id: string) => {
    try {
      await checked(await pwaApi.pairings[":id"].cancel.$post({ param: { id } }, approvalRequestOptions()));
    } catch (cause) {
      // Already over on the server: nothing left to cancel.
      if (!(cause instanceof ApprovalError && (cause.code === "EXPIRED" || cause.code === "NOT_FOUND")) && !disposed)
        toast.error(t().pwaFailed);
    }
  };

  const copy = async () => {
    const current = pairing();
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

  /** Only a code on its way to the server holds the dialog open; everything else may be cancelled. */
  const confirming = () => busy() && step() === "code";
  /** The first task of the current screen: the code's first digit, or the screen's main button. */
  const focusTarget = () =>
    step() === "code"
      ? (dialogBody?.querySelector<HTMLElement>(".k2b-pin-input input") ?? null)
      : (dialogBody?.closest(".k2b-panel-dialog")?.querySelector<HTMLElement>("[data-pairing-focus]") ?? null);
  const requestClose = () => {
    if (!confirming()) closeDialog?.();
  };

  /** Opens the dialog; `resume` continues a pairing this tab started before a reload. */
  const open = (resume?: z.infer<typeof ResumeSchema>) => {
    if (closeDialog || disposed) return;
    const qrCode = window.matchMedia("(pointer: fine)").matches;
    setShowQr(qrCode);
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    void dialogCore
      .open<void>(
        (close, context) => {
          closeDialog = close;
          context.setDismissHandler(requestClose);
          return content();
        },
        {
          ...panelDialogFixedOptions,
          // Without the QR code the tallest step is the code entry, so the frame is shorter.
          panelClassName: `${panelDialogFixedOptions.panelClassName} app-pairing-dialog${qrCode ? "" : " is-copy-only"}`,
          // The step owns focus, also when the first answer arrives before the dialog's first frame.
          initialFocus: focusTarget,
        },
      )
      .then(() => {
        clearInterval(timer);
        closeDialog = undefined;
        // Leaving the page keeps the pairing, so a reload of this tab resumes it.
        if (disposed) return;
        generation += 1;
        const current = pairing();
        // Closing is cancelling: an open pairing must not stay claimable.
        stop();
        remember(null);
        if (current.kind === "waiting") void cancelPending(current.id);
        setCode("");
        setWrongCode(undefined);
        setBusy(false);
        setPairing({ kind: "starting" });
      });
    if (resume) {
      setPairing({ kind: "waiting", id: resume.id, expiresAt: resume.expiresAt, link: null, claimUntil: null, status: null });
      watch(resume.id, resume.expiresAt, true);
    } else void start();
  };

  onMount(() => {
    const url = new URL(window.location.href);
    const requested = url.searchParams.get("pair") === "1";
    if (requested) {
      url.searchParams.delete("pair");
      url.searchParams.delete("reauthenticate");
      window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
    }
    try {
      const saved = ResumeSchema.safeParse(JSON.parse(window.sessionStorage.getItem(storageKey) || "null"));
      if (saved.success && Date.parse(saved.data.expiresAt) > Date.now()) return open(saved.data);
      remember(null);
    } catch {
      remember(null);
    }
    if (requested) open();
  });
  onCleanup(() => {
    disposed = true;
    stop();
    stopCompletion();
    closeDialog?.();
  });

  const remaining = (until: string) => {
    // Clamped, so a server clock slightly ahead never shows more than the link's lifetime.
    const seconds = Math.min(PWA_LIMITS.linkClaimSeconds, Math.max(0, Math.ceil((Date.parse(until) - now()) / 1000)));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  };
  const day = (value: string) => {
    const context = { ...props.dateConfig, locale: locale() };
    if (dates.isToday(new Date(value), context)) return t().pwaToday;
    if (dates.isToday(new Date(Date.parse(value) + 86_400_000), context)) return t().pwaYesterday;
    return dates.formatDate(value, context);
  };
  const waiting = () => {
    const current = pairing();
    return current.kind === "waiting" ? current : null;
  };
  /** One name per screen of the dialog; the body changes only when it changes. */
  const step = createMemo(() => {
    const current = pairing();
    if (current.kind !== "waiting") return current.kind;
    if (current.status?.state === "claimed") return "code";
    return current.link ? "link" : "resumed";
  });
  const errorText = (code: string) =>
    code === "LIMIT_REACHED" ? t().pwaLimit : code === "UNAVAILABLE" ? t().pwaUnavailable : t().pwaFailed;
  const outcome = () => {
    const current = pairing();
    if (current.kind === "done")
      return { icon: "ti ti-circle-check", tone: toneClass.success, text: t().pwaPairedTitle({ name: current.name }) };
    if (current.kind === "expired") return { icon: "ti ti-clock-x", tone: toneClass.warning, text: t().pwaExpired };
    if (current.kind === "locked") return { icon: "ti ti-lock", tone: toneClass.warning, text: t().pwaTooManyTries };
    if (current.kind === "cancelled") return { icon: "ti ti-circle-x", tone: toneClass.warning, text: t().pwaCancelled };
    if (current.kind === "reauthenticate") return { icon: "ti ti-shield-lock", tone: toneClass.warning, text: t().pwaReauthenticateHint };
    if (current.kind === "error") return { icon: "ti ti-alert-circle", tone: toneClass.danger, text: errorText(current.code) };
    return null;
  };

  // Each screen of the dialog moves focus to its first task and tells screen readers what changed.
  createEffect(
    on(step, (current, previous) => {
      if (!closeDialog || current === previous) return;
      const result = outcome();
      if (current === "code") announce(t().pwaClaimed({ name: waiting()?.status?.device?.name ?? "" }));
      else if (current === "link") announce(showQr() ? t().pwaScanOrCopy : t().pwaCopyOnPhone);
      else if (result) announce(current === "done" ? `${result.text} ${t().pwaPaired}` : result.text);
      queueMicrotask(() => focusTarget()?.focus());
    }),
  );

  const text = "text-sm";
  const secondary = "text-sm text-dimmed";
  const content = () => (
    <PanelDialog>
      <PanelDialog.Header title={t().pwaPair} icon="ti ti-device-mobile" close={requestClose} closeDisabled={confirming()} />
      <PanelDialog.Body>
        <div ref={dialogBody} class="flex flex-col gap-4">
          <Switch>
            <Match when={step() === "starting"}>
              <p class={`${secondary} flex items-center gap-2`} role="status">
                <i class="ti ti-loader-2 animate-spin" aria-hidden="true" />
                {t().pwaPreparing}
              </p>
            </Match>
            <Match when={step() === "link" && waiting()}>
              {(current) => (
                <>
                  <p class={text}>{showQr() ? t().pwaScanOrCopy : t().pwaCopyOnPhone}</p>
                  <Show when={showQr() && current().link}>
                    {(link) => (
                      <img
                        class="size-56 max-w-full self-center rounded-[var(--ui-radius-control)] bg-white p-2"
                        alt={t().pwaQrLabel}
                        src={`data:image/svg+xml,${encodeURIComponent(qr.toSvg(link()))}`}
                      />
                    )}
                  </Show>
                  <Show when={current().claimUntil}>
                    {(until) => (
                      <p class={`${secondary} tabular-nums ${showQr() ? "text-center" : ""}`}>
                        {t().pwaLinkValid({ time: remaining(until()) })}
                      </p>
                    )}
                  </Show>
                  <Show
                    when={showQr()}
                    fallback={
                      <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
                        <p class={secondary}>{t().pwaNoAppOnPhone}</p>
                        <ButtonLink href="/pwa/" variant="secondary" size="sm">
                          <i class="ti ti-download" aria-hidden="true" />
                          {t().pwaInstall}
                        </ButtonLink>
                      </div>
                    }
                  >
                    <p class={secondary}>{t().pwaNoAppYet}</p>
                  </Show>
                </>
              )}
            </Match>
            <Match when={step() === "resumed"}>
              <p class={secondary}>{t().pwaResumed}</p>
            </Match>
            <Match when={step() === "code"}>
              <p class={text}>{t().pwaClaimed({ name: waiting()?.status?.device?.name ?? "" })}</p>
              <PinInput
                label={t().pwaCode}
                length={6}
                stretch
                value={code}
                onValueChange={(value) => {
                  setCode(value);
                  if (value) setWrongCode(undefined);
                }}
                onSubmit={confirm}
                readOnly={busy()}
                error={() => {
                  const count = wrongCode();
                  return count === undefined ? undefined : t().pwaWrongCode({ count });
                }}
              />
            </Match>
            <Match when={outcome()}>
              {(result) => (
                <div class="flex flex-col items-center gap-2 py-6 text-center">
                  <i class={`${result().icon} text-3xl ${result().tone}`} aria-hidden="true" />
                  <p class={step() === "done" ? `${text} font-medium` : text}>{result().text}</p>
                  <Show when={step() === "done"}>
                    <p class={secondary}>{t().pwaPaired}</p>
                  </Show>
                </div>
              )}
            </Match>
          </Switch>
        </div>
      </PanelDialog.Body>
      <PanelDialog.Footer>
        <div class="flex w-full flex-wrap justify-end gap-2">
          <Switch>
            <Match when={step() === "starting" || step() === "resumed"}>
              <Button data-pairing-focus variant="ghost" onClick={requestClose}>
                {t().pwaCancel}
              </Button>
            </Match>
            <Match when={step() === "link"}>
              <Button variant="ghost" onClick={requestClose}>
                {t().pwaCancel}
              </Button>
              <Button data-pairing-focus variant={showQr() ? "secondary" : "primary"} onClick={copy}>
                <i class="ti ti-copy" aria-hidden="true" />
                {t().pwaCopyLink}
              </Button>
            </Match>
            <Match when={step() === "code"}>
              <Button variant="ghost" onClick={requestClose} disabled={confirming()}>
                {t().pwaCancel}
              </Button>
              <Button loading={busy()} disabled={code().length !== 6} onClick={confirm}>
                {t().pwaConfirm}
              </Button>
            </Match>
            <Match when={step() === "done"}>
              <Button data-pairing-focus onClick={requestClose}>
                {t().pwaDone}
              </Button>
            </Match>
            <Match when={step() === "reauthenticate"}>
              <Button variant="ghost" onClick={requestClose}>
                {t().pwaClose}
              </Button>
              <Button data-pairing-focus onClick={reauthenticate}>
                {t().pwaReauthenticate}
              </Button>
            </Match>
            <Match when={outcome()}>
              <Button variant="ghost" onClick={requestClose}>
                {t().pwaClose}
              </Button>
              <Button data-pairing-focus loading={busy()} onClick={start}>
                {t().pwaStartAgain}
              </Button>
            </Match>
          </Switch>
        </div>
      </PanelDialog.Footer>
    </PanelDialog>
  );

  return (
    <SettingsSection
      title={t().pwaPhones}
      actions={
        <Button size="sm" onClick={() => open()}>
          {t().pwaPair}
        </Button>
      }
    >
      <Show when={devices().length} fallback={<p class={secondary}>{t().pwaNoPhones}</p>}>
        <ul class="flex flex-col gap-2">
          <For each={devices()}>
            {(device) => (
              <li class="flex min-h-11 items-center gap-3">
                <i
                  class={`${icon(device.platform)} text-lg text-dimmed`}
                  role="img"
                  aria-label={t().pwaPlatform({ platform: device.platform })}
                />
                <div class="min-w-0 flex-1">
                  <p class={`${text} break-words font-medium`}>{device.name}</p>
                  <p class={secondary}>
                    {device.current ? `${t().pwaThisPhone} · ` : ""}
                    {t().pwaLastUsed({ when: day(device.lastUsedAt) })}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={t().pwaRemoveDevice({ name: device.name })}
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
  );
}
