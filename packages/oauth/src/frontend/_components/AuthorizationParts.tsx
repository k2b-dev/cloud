import { Button, useLocale } from "@k2b/ui";
import { For, type JSX, Show } from "solid-js";
import { oauthMessages } from "../messages";
import { consentScopeLabel } from "../scope-labels";

/** The `id` of the page heading that `AuthorizationPage` names its card by. */
export const PAGE_TITLE_ID = "oauth-page-title";

const useMessages = () => {
  const locale = useLocale();
  return () => oauthMessages.resolve([locale()]).t;
};

/** The heading of a decision, with an optional dimmed line below it. */
export function DecisionHeader(props: { title: string; children?: JSX.Element }) {
  return (
    <header>
      <h1 id={PAGE_TITLE_ID} class="break-words text-xl font-semibold leading-snug text-primary">
        {props.title}
      </h1>
      <Show when={props.children}>
        <p class="mt-2 text-sm text-dimmed">{props.children}</p>
      </Show>
    </header>
  );
}

/** Every requested scope in words, and the reminder that Cloud permissions still apply. */
export function RequestedAccess(props: { scopes: readonly string[] }) {
  const t = useMessages();
  return (
    <section class="mt-6" aria-labelledby="oauth-requested-access">
      <h2 id="oauth-requested-access" class="text-sm font-medium text-primary">
        {t().requestedAccess}
      </h2>
      <ul class="mt-2 grid gap-1.5">
        <For each={props.scopes}>
          {(scope) => (
            <li class="flex items-start gap-2 text-sm text-secondary">
              <i class="ti ti-check mt-0.5 shrink-0 text-dimmed" aria-hidden="true" />
              <span>{consentScopeLabel(scope, t())}</span>
            </li>
          )}
        </For>
      </ul>
      <p class="mt-3 text-xs text-dimmed">{t().permissionLimit}</p>
    </section>
  );
}

/** A caution the person reads right before deciding: plain text with one icon, no tinted box. */
export function CautionNote(props: { children: JSX.Element }) {
  return (
    <p class="mt-6 flex items-start gap-2 text-sm text-secondary">
      <i class="ti ti-alert-triangle mt-0.5 shrink-0 text-[var(--k2b-warning-text)]" aria-hidden="true" />
      <span>{props.children}</span>
    </p>
  );
}

/**
 * Deny and Allow as two equal buttons in one row, Allow last and primary. The
 * row keeps its order on phones, so the reading and focus order stay the same.
 */
export function DecisionForm(props: { action: string; request: string }) {
  const t = useMessages();
  return (
    <form method="post" action={props.action} class="mt-6 grid grid-cols-2 gap-3">
      <input type="hidden" name="request" value={props.request} />
      <Button type="submit" name="decision" value="deny" variant="secondary" size="lg" class="w-full">
        {t().deny}
      </Button>
      <Button type="submit" name="decision" value="approve" size="lg" class="w-full">
        {t().allowAccess}
      </Button>
    </form>
  );
}

/** The final state of a decision. It is a status region, so assistive technology reads it as the result. */
export function Outcome(props: { icon: string; success?: boolean; title: string; body: JSX.Element; children?: JSX.Element }) {
  return (
    <div role="status" class="flex flex-col items-center text-center" data-testid="oauth-outcome">
      <i class={`${props.icon} text-4xl ${props.success ? "text-[var(--k2b-success-text)]" : "text-dimmed"}`} aria-hidden="true" />
      <h1 id={PAGE_TITLE_ID} class="mt-3 break-words text-xl font-semibold leading-snug text-primary">
        {props.title}
      </h1>
      <p class="mt-2 text-sm text-dimmed">{props.body}</p>
      <Show when={props.children}>
        <div class="mt-6 flex w-full flex-col gap-4">{props.children}</div>
      </Show>
    </div>
  );
}
