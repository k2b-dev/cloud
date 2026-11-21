import { ButtonLink, Disclosure, Placeholder, StatusBadge, useLocale } from "@k2b/ui";
import { For, Show } from "solid-js";
import type { CodeHelpReference } from "../../code/help-reference";
import { codeHelpMessages } from "./code-help-messages";

const POLICY_TONE = { automatic: "ok", admin: "neutral", never: "error" } as const;
const POLICY_ICON = { automatic: "ti ti-circle-check", admin: "ti ti-user-shield", never: "ti ti-ban" } as const;

/**
 * The generated Code part of an app's Help start: the app's SDK operations and automation events, as Gustav's
 * `code_sdk` index lists them. Server HTML only; the groups open with native disclosure, so the start stays short.
 */
export function CodeHelpSection(props: { reference: CodeHelpReference | "failed"; appName: string; reloadHref: string }) {
  const locale = useLocale();
  const t = () => codeHelpMessages.resolve([locale()]).t;
  const reference = () => (props.reference === "failed" ? null : props.reference);
  const empty = () => {
    const value = reference();
    return value !== null && value.operations.length === 0 && value.events.length === 0;
  };
  return (
    <section class="help-start-section" data-help-code="" aria-labelledby="help-start-code-title">
      <h3 id="help-start-code-title" class="help-start-heading">
        <i class="ti ti-code" aria-hidden="true" />
        {t().title}
      </h3>
      <Show
        when={reference()}
        fallback={
          <Placeholder
            state="error"
            variant="inline"
            align="left"
            description={t().failed}
            action={
              <ButtonLink href={props.reloadHref} size="sm" variant="secondary">
                {t().reload}
              </ButtonLink>
            }
          />
        }
      >
        {(value) => (
          <Show
            when={!empty()}
            fallback={<Placeholder variant="inline" align="left" icon="ti ti-code-off" description={t().empty({ app: props.appName })} />}
          >
            <p class="m-0 text-sm text-(--k2b-text-muted)">{t().lead({ app: props.appName })}</p>
            <Show when={value().export}>
              {(name) => (
                <code class="block overflow-x-auto rounded-(--ui-radius-control) bg-(--ui-surface-subtle) px-3 py-2 text-[0.8125rem] whitespace-pre">
                  {`import { ${name()} } from "@sdk";`}
                </code>
              )}
            </Show>
            <Show when={value().operations.length > 0}>
              <Disclosure surface="plain" summary={t().operations({ count: value().operations.length })}>
                <ul class="m-0 flex list-none flex-col p-0" data-help-code-operations="">
                  <For each={value().operations}>
                    {(operation) => (
                      <li class="flex min-w-0 flex-col gap-1 border-b border-(--k2b-border) py-2.5 last:border-b-0">
                        <code class="min-w-0 text-[0.8125rem] break-all" data-help-code-path="">
                          {operation.path}
                        </code>
                        <Show when={operation.description}>
                          <p class="m-0 text-sm text-(--k2b-text-muted)">{operation.description}</p>
                        </Show>
                        {/* One place in every row, so the eye finds the label without searching. */}
                        <StatusBadge
                          tone={POLICY_TONE[operation.policy]}
                          variant="text"
                          icon={POLICY_ICON[operation.policy]}
                          label={t().policy({ value: operation.policy })}
                          title={t().policyHint({ value: operation.policy })}
                          class="self-start"
                        />
                      </li>
                    )}
                  </For>
                </ul>
              </Disclosure>
            </Show>
            <Show when={value().events.length > 0}>
              <Disclosure surface="plain" summary={t().events({ count: value().events.length })}>
                <ul class="m-0 flex list-none flex-col p-0" data-help-code-events="">
                  <For each={value().events}>
                    {(event) => (
                      <li class="flex min-w-0 flex-col gap-1 border-b border-(--k2b-border) py-2.5 last:border-b-0">
                        <code class="min-w-0 text-[0.8125rem] break-all">{event.type}</code>
                        <Show when={event.description}>
                          <p class="m-0 text-sm text-(--k2b-text-muted)">{event.description}</p>
                        </Show>
                        <dl class="m-0 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-(--k2b-text-muted)">
                          <div class="flex min-w-0 gap-1">
                            <dt>{t().subject}</dt>
                            <dd class="m-0 min-w-0 break-all">
                              <code>{event.subject}</code>
                            </dd>
                          </div>
                          <div class="flex min-w-0 gap-1">
                            <dt>{t().place}</dt>
                            <dd class="m-0 min-w-0 break-all">{event.place ? <code>{event.place}</code> : t().noPlace}</dd>
                          </div>
                        </dl>
                      </li>
                    )}
                  </For>
                </ul>
              </Disclosure>
            </Show>
          </Show>
        )}
      </Show>
    </section>
  );
}
