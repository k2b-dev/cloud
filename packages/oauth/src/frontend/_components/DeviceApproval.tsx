import { Button, ButtonLink, NoticeCard, useLocale } from "@k2b/ui";
import { For, type JSX, Match, Switch } from "solid-js";
import { oauthMessages } from "../messages";
import { consentScopeLabel } from "../scope-labels";
import DeviceCodeForm from "./DeviceCodeForm.island";

export type DeviceApprovalView =
  | { kind: "entry"; code?: string; error?: string }
  | { kind: "confirm"; request: string; code: string; client: { name: string; clientId: string }; scopes: string[] }
  | { kind: "result"; outcome: "approved" | "denied" | "expired" | "blocked"; message?: string };

const tones = {
  info: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
  success: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300",
  danger: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300",
  warning: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
} as const;

function Heading(props: { icon: string; tone: keyof typeof tones; title: string; last?: boolean; children?: JSX.Element }) {
  return (
    <div class={`flex items-start gap-3 ${props.last ? "" : "mb-5"}`}>
      <span
        class={`flex h-11 w-11 shrink-0 items-center justify-center rounded-[var(--ui-radius-control)] ${tones[props.tone]}`}
        aria-hidden="true"
      >
        <i class={`${props.icon} text-xl`} />
      </span>
      <div class="min-w-0">
        <h1 class="text-lg font-semibold text-primary">{props.title}</h1>
        {props.children}
      </div>
    </div>
  );
}

/** The complete device approval surface; the server decides which state is shown. */
export function DeviceApproval(props: { view: DeviceApprovalView }) {
  const locale = useLocale();
  const t = () => oauthMessages.resolve([locale()]).t;

  return (
    <main class="mx-auto flex w-full max-w-lg flex-col gap-5">
      <section class="paper p-6 sm:p-7">
        <Switch>
          <Match when={props.view.kind === "entry" && props.view}>
            {(view) => (
              <>
                <Heading icon="ti ti-terminal-2" tone="info" title={t().deviceTitle}>
                  <p class="mt-1 text-sm text-dimmed">{t().deviceEnterCode}</p>
                </Heading>
                <DeviceCodeForm code={view().code} error={view().error} />
              </>
            )}
          </Match>
          <Match when={props.view.kind === "confirm" && props.view}>
            {(view) => (
              <>
                <Heading icon="ti ti-terminal-2" tone="info" title={t().deviceConfirmTitle({ name: view().client.name })} />

                <div class="mb-5 rounded-[var(--ui-radius-control)] bg-[var(--ui-surface-subtle)] p-4">
                  <p class="text-sm text-secondary">{t().deviceConfirmCode}</p>
                  <p class="mt-2 font-mono text-2xl font-semibold tracking-[0.2em] text-primary" data-testid="device-user-code">
                    {view().code}
                  </p>
                  <dl class="mt-4">
                    <dt class="text-xs font-medium uppercase tracking-wide text-dimmed">{t().clientId}</dt>
                    <dd class="mt-1 break-all font-mono text-xs text-secondary">{view().client.clientId}</dd>
                  </dl>
                </div>

                <div class="mb-5">
                  <h2 class="text-sm font-semibold text-primary">{t().requestedAccess}</h2>
                  <ul class="mt-3 grid gap-2">
                    <For each={view().scopes}>
                      {(scope) => (
                        <li class="flex items-start gap-2 text-sm text-secondary">
                          <i class="ti ti-check mt-0.5 text-emerald-600" aria-hidden="true" />
                          <span>{consentScopeLabel(scope, t())}</span>
                        </li>
                      )}
                    </For>
                  </ul>
                </div>

                <NoticeCard tone="warning" class="mb-6">
                  {t().deviceOwnCodeWarning}
                </NoticeCard>

                <form method="post" action="/oauth/device" class="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                  <input type="hidden" name="request" value={view().request} />
                  <Button type="submit" name="decision" value="deny" variant="secondary">
                    {t().deny}
                  </Button>
                  <Button type="submit" name="decision" value="approve">
                    {t().allowAccess}
                  </Button>
                </form>
              </>
            )}
          </Match>
          <Match when={props.view.kind === "result" && props.view}>
            {(view) => (
              <Switch>
                <Match when={view().outcome === "approved"}>
                  <Heading icon="ti ti-circle-check" tone="success" title={t().deviceApprovedTitle} last>
                    <p class="mt-1 text-sm text-dimmed">{t().deviceApprovedBody}</p>
                  </Heading>
                </Match>
                <Match when={view().outcome === "denied"}>
                  <Heading icon="ti ti-circle-x" tone="danger" title={t().deviceDeniedTitle} last>
                    <p class="mt-1 text-sm text-dimmed">{t().deviceDeniedBody}</p>
                  </Heading>
                </Match>
                <Match when={view().outcome === "expired"}>
                  <Heading icon="ti ti-clock-x" tone="warning" title={t().deviceExpiredTitle}>
                    <p class="mt-1 text-sm text-dimmed">{view().message ?? t().deviceExpiredBody}</p>
                  </Heading>
                  <ButtonLink href="/oauth/device" variant="secondary">
                    {t().deviceEnterAnother}
                  </ButtonLink>
                </Match>
                <Match when={view().outcome === "blocked"}>
                  <Heading icon="ti ti-lock" tone="danger" title={t().authorizationFailed} last>
                    <p class="mt-1 text-sm text-dimmed">{view().message}</p>
                  </Heading>
                </Match>
              </Switch>
            )}
          </Match>
        </Switch>
      </section>
      <p class="px-2 text-center text-xs text-dimmed">{t().permissionLimit}</p>
    </main>
  );
}
