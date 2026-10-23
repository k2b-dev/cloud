import { apiClient } from "@k2b/cloud/clients/core";
import { PWA_LIMITS, pairingLink, PwaPairingStartResultSchema, PwaPairingStatusSchema } from "@k2b/cloud/contracts";
import { refreshCurrentPath } from "@k2b/ssr/nav";
import { qr } from "@k2b/stdlib/qr";
import { Button, ButtonLink, dialogCore, PanelDialog, PinInput, useLocale } from "@k2b/ui";
import { createEffect, createSignal, For, Match, onCleanup, onMount, Show, Switch } from "solid-js";
import { z } from "zod";
import { accountsMessages } from "../../messages";

const api = apiClient.auth.pwa.v1;
const Resume = z.object({ id: z.string().uuid(), expiresAt: z.string().datetime() });
type Pairing = z.infer<typeof Resume> & { link?: string; claimUntil?: string };
type Status = z.infer<typeof PwaPairingStatusSchema>;
type Step = "starting" | "link" | "code" | "waiting" | "done" | "rejected" | "expired" | "locked" | "reauthenticate" | "error";
type Props = { userId: string; name: string; blocked: boolean };

class PairingError extends Error {
  constructor(
    readonly code: string,
    readonly attemptsLeft?: number,
  ) {
    super(code);
  }
}
const checked = async <T extends Pick<Response, "ok" | "json">>(response: T) => {
  if (response.ok) return response;
  const error = await response.json().catch(() => null);
  const parsed = z.object({ code: z.string(), attemptsLeft: z.number().optional() }).safeParse(error);
  throw new PairingError(parsed.success ? parsed.data.code : "UNAVAILABLE", parsed.success ? parsed.data.attemptsLeft : undefined);
};

export default function PairCloudApp(props: Props) {
  const locale = useLocale();
  const t = () => accountsMessages.resolve([locale()]).t;
  const storageKey = `cloud.admin-pwa-pairing:${props.userId}`;
  let closeDialog: (() => void) | undefined;
  let disposed = false;
  let succeeded = false;
  const remember = (pairing: Pairing | null) => {
    try {
      if (pairing) window.sessionStorage.setItem(storageKey, JSON.stringify({ id: pairing.id, expiresAt: pairing.expiresAt }));
      else window.sessionStorage.removeItem(storageKey);
    } catch {
      /* The dialog also works without tab storage. */
    }
  };
  const cancel = async (id: string) => {
    await checked(await api.pairings[":id"].cancel.$post({ param: { id } }));
  };

  const open = (resume?: Pairing) => {
    if (closeDialog || disposed || props.blocked) return;
    void dialogCore
      .open<void>(
        (close, context) => {
          closeDialog = close;
          const [step, setStep] = createSignal<Step>("starting");
          const [pairing, setPairing] = createSignal<Pairing>();
          const [status, setStatus] = createSignal<Status>();
          const [wrongCode, setWrongCode] = createSignal<string>();
          const [code, setCode] = createSignal("");
          const [busy, setBusy] = createSignal(false);
          const [error, setError] = createSignal<string>();
          const [connectionError, setConnectionError] = createSignal<string>();
          const [now, setNow] = createSignal(Date.now());
          const [copied, setCopied] = createSignal(false);
          let timer: ReturnType<typeof setTimeout> | undefined;
          let active = true;
          let controller: AbortController | undefined;
          let body: HTMLDivElement | undefined;
          const stop = () => {
            clearTimeout(timer);
            controller?.abort();
          };
          const finish = (value: Step) => {
            stop();
            setStep(value);
            remember(null);
          };
          const fail = (cause: unknown) => {
            if (cause instanceof PairingError) {
              if (cause.code === "REAUTHENTICATE") return finish("reauthenticate");
              if (cause.code === "EXPIRED" || cause.code === "NOT_FOUND") return finish(cause.attemptsLeft === 0 ? "locked" : "expired");
              if (cause.code === "ACCOUNT_BLOCKED") {
                setError(t().cloudAppBlocked({ name: props.name }));
                return finish("error");
              }
              if (cause.code === "LIMIT_REACHED") {
                setError(t().cloudAppLimit);
                return finish("error");
              }
              if (cause.code === "FORBIDDEN") {
                setError(t().cloudAppReauthenticate);
                return finish("reauthenticate");
              }
            }
            setError(cause instanceof PairingError && cause.code === "UNAVAILABLE" ? t().cloudAppUnavailable : t().cloudAppFailed);
          };
          const poll = async () => {
            const current = pairing();
            if (!active || !current) return;
            if (Date.parse(current.expiresAt) <= Date.now()) return finish("expired");
            const requestController = new AbortController();
            controller = requestController;
            try {
              const response = await checked(
                await api.pairings[":id"].$get({ param: { id: current.id } }, { init: { signal: requestController.signal } }),
              );
              const state = PwaPairingStatusSchema.parse(await response.json());
              if (!active || requestController.signal.aborted) return;
              setStatus(state);
              setConnectionError(undefined);
              if (state.state === "completed") {
                succeeded = true;
                return finish("done");
              }
              if (state.state === "rejected") return finish("rejected");
              if (state.state === "cancelled") return finish(state.attemptsLeft === 0 ? "locked" : "expired");
              setStep(
                state.state === "claimed" ? "code" : state.state === "awaiting_device" || state.state === "confirmed" ? "waiting" : "link",
              );
            } catch (cause) {
              if (active && !requestController.signal.aborted) {
                if (cause instanceof PairingError && !["UNAVAILABLE", "INVALID_REQUEST"].includes(cause.code)) fail(cause);
                else setConnectionError(t().cloudAppFailed);
              }
            }
            if (active && !requestController.signal.aborted && ["link", "code", "waiting"].includes(step()))
              timer = setTimeout(() => void poll(), PWA_LIMITS.pollSeconds * 1000);
          };
          const start = async () => {
            stop();
            setCode("");
            setWrongCode(undefined);
            setStep("starting");
            setError(undefined);
            setConnectionError(undefined);
            setCopied(false);
            setBusy(true);
            try {
              const result = PwaPairingStartResultSchema.parse(
                await (await checked(await api.users[":userId"].pairings.$post({ param: { userId: props.userId } }))).json(),
              );
              if (!active) {
                await cancel(result.id);
                return;
              }
              const current = { ...result, link: pairingLink(location.origin, result.secret) };
              setPairing(current);
              remember(current);
              setStep("link");
              void poll();
            } catch (cause) {
              if (active) {
                fail(cause);
                if (step() === "starting") setStep("error");
              }
            } finally {
              if (active) setBusy(false);
            }
          };
          const confirm = async () => {
            const current = pairing();
            if (!current || busy() || code().length !== 6) return;
            stop();
            setBusy(true);
            setError(undefined);
            try {
              await checked(await api.pairings[":id"].confirm.$post({ param: { id: current.id }, json: { code: code() } }));
              if (active) {
                setStep("waiting");
                void poll();
              }
            } catch (cause) {
              if (!active) return;
              if (cause instanceof PairingError && cause.code === "WRONG_CODE") {
                setCode("");
                setWrongCode(t().cloudAppWrongCode({ count: cause.attemptsLeft ?? 0 }));
                body?.querySelector<HTMLInputElement>("input")?.focus();
              } else if (cause instanceof PairingError && !["UNAVAILABLE", "INVALID_REQUEST"].includes(cause.code)) fail(cause);
              else setConnectionError(t().cloudAppFailed);
              if (["code", "waiting"].includes(step())) void poll();
            } finally {
              if (active) setBusy(false);
            }
          };
          const requestClose = async () => {
            if (busy()) return;
            const current = pairing();
            if (current && ["link", "code", "waiting"].includes(step())) {
              stop();
              setBusy(true);
              try {
                await cancel(current.id);
              } catch (cause) {
                fail(cause);
                setBusy(false);
                void poll();
                return;
              }
            }
            remember(null);
            close();
          };
          context.setDismissHandler(() => void requestClose());
          const copy = async () => {
            const link = pairing()?.link;
            if (!link) return;
            try {
              await navigator.clipboard.writeText(link);
              setCopied(true);
              setError(undefined);
            } catch {
              setError(t().cloudAppCopyFailed);
            }
          };
          const remaining = () => {
            const until = step() === "link" ? (pairing()?.claimUntil ?? pairing()?.expiresAt) : pairing()?.expiresAt;
            const seconds = Math.max(0, Math.ceil((Date.parse(until ?? "") - now()) / 1000));
            return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
          };
          const signInHref = () => {
            const url = new URL(location.href);
            url.searchParams.set("pairCloudApp", "1");
            return `/auth/login?${new URLSearchParams({ redirectTo: url.pathname + url.search, credential: "legacy" })}`;
          };
          onMount(() => {
            const clock = setInterval(() => setNow(Date.now()), 1000);
            onCleanup(() => clearInterval(clock));
            if (resume) {
              setPairing(resume);
              setStep("link");
              void poll();
            } else void start();
          });
          onCleanup(() => {
            active = false;
            stop();
          });
          createEffect(() => {
            const current = step();
            queueMicrotask(() => {
              if (active) (current === "code" ? body?.querySelector<HTMLInputElement>("input") : body)?.focus();
            });
          });
          return (
            <PanelDialog>
              <PanelDialog.Header
                title={t().cloudAppPairTitle({ name: props.name })}
                close={() => void requestClose()}
                closeDisabled={busy()}
              />
              <PanelDialog.Body>
                <div ref={body} tabindex="-1" class="flex flex-col gap-4" aria-live="polite">
                  <Switch>
                    <Match when={step() === "starting"}>
                      <p role="status">{t().cloudAppPreparing}</p>
                    </Match>
                    <Match when={step() === "link" || step() === "code"}>
                      <p>{t().cloudAppPairWarning({ name: props.name })}</p>
                      <ol class="list-decimal pl-5 text-sm">
                        <For each={[t().cloudAppPairStepOne, t().cloudAppPairStepTwo, t().cloudAppPairStepThree]}>
                          {(item) => <li>{item}</li>}
                        </For>
                      </ol>
                      <Show when={step() === "link"}>
                        <Show when={pairing()?.link} fallback={<p>{t().cloudAppResumed}</p>}>
                          {(link) => (
                            <img
                              class="size-56 max-w-full self-center rounded-[var(--ui-radius-control)] bg-white p-2"
                              alt={t().cloudAppPair}
                              src={`data:image/svg+xml,${encodeURIComponent(qr.toSvg(link()))}`}
                            />
                          )}
                        </Show>
                        <Show when={pairing()?.link}>
                          <Button variant="secondary" onClick={copy}>
                            {copied() ? t().cloudAppCopied : t().cloudAppCopy}
                          </Button>
                        </Show>
                      </Show>
                      <Show when={step() === "code"}>
                        <PinInput
                          label={t().cloudAppCode}
                          length={6}
                          value={code}
                          onValueChange={(value) => {
                            setCode(value);
                            if (value) setWrongCode(undefined);
                          }}
                          onSubmit={confirm}
                          readOnly={busy()}
                          error={wrongCode}
                          stretch
                        />
                      </Show>
                    </Match>
                    <Match when={step() === "waiting"}>
                      <p role="status">{t().cloudAppWaiting({ name: props.name })}</p>
                    </Match>
                    <Match when={step() === "done"}>
                      <p>{t().cloudAppSuccess({ name: status()?.device?.name ?? "" })}</p>
                      <p class="text-sm text-dimmed">{t().cloudAppSuccessHint({ name: props.name })}</p>
                    </Match>
                    <Match when={step() === "rejected"}>
                      <p>{t().cloudAppRejected({ name: props.name })}</p>
                    </Match>
                    <Match when={step() === "expired"}>
                      <p>{t().cloudAppExpired}</p>
                    </Match>
                    <Match when={step() === "locked"}>
                      <p>{t().cloudAppLocked}</p>
                    </Match>
                    <Match when={step() === "reauthenticate"}>
                      <p>{t().cloudAppReauthenticate}</p>
                    </Match>
                  </Switch>
                  <Show when={pairing() && ["link", "code", "waiting"].includes(step())}>
                    <p class="text-sm text-dimmed tabular-nums">{t().cloudAppValid({ time: remaining() })}</p>
                  </Show>
                  <Show when={connectionError()}>
                    <p role="alert">{connectionError()}</p>
                  </Show>
                  <Show when={error()}>
                    <p role="alert">{error()}</p>
                  </Show>
                </div>
              </PanelDialog.Body>
              <PanelDialog.Footer>
                <Button variant="ghost" disabled={busy()} onClick={() => void requestClose()}>
                  {t().close}
                </Button>
                <Show when={step() === "code"}>
                  <Button loading={busy()} disabled={code().length !== 6} onClick={confirm}>
                    {t().cloudAppConfirm}
                  </Button>
                </Show>
                <Show when={step() === "reauthenticate"}>
                  <ButtonLink href={signInHref()}>{t().cloudAppSignIn}</ButtonLink>
                </Show>
                <Show when={["expired", "locked", "rejected", "error"].includes(step())}>
                  <Button onClick={start} loading={busy()}>
                    {t().cloudAppAgain}
                  </Button>
                </Show>
              </PanelDialog.Footer>
            </PanelDialog>
          );
        },
        { ariaLabel: t().cloudAppPairTitle({ name: props.name }) },
      )
      .then(() => {
        closeDialog = undefined;
        if (succeeded && !disposed) void refreshCurrentPath();
      });
  };
  onMount(() => {
    if (props.blocked) return;
    const url = new URL(location.href);
    const requested = url.searchParams.get("pairCloudApp") === "1";
    if (requested) {
      url.searchParams.delete("pairCloudApp");
      history.replaceState(history.state, "", url.pathname + url.search + url.hash);
    }
    try {
      const saved = Resume.safeParse(JSON.parse(window.sessionStorage.getItem(storageKey) ?? "null"));
      if (saved.success && Date.parse(saved.data.expiresAt) > Date.now()) return open(saved.data);
      remember(null);
    } catch {
      remember(null);
    }
    if (requested) open();
  });
  onCleanup(() => {
    disposed = true;
    closeDialog?.();
  });
  return (
    <div class="flex flex-col items-end gap-1">
      <Button
        size="sm"
        disabled={props.blocked}
        onClick={() => open()}
        aria-describedby={props.blocked ? `pwa-blocked-${props.userId}` : undefined}
      >
        {t().cloudAppPair}
      </Button>
      <Show when={props.blocked}>
        <p id={`pwa-blocked-${props.userId}`} class="text-xs text-dimmed">
          {t().cloudAppBlocked({ name: props.name })}
        </p>
      </Show>
    </div>
  );
}
