import { FeatCodeMark } from "@k2b/cloud/code/ui";
import { i18n } from "@k2b/stdlib";
import { Button, ButtonLink, Paper, useLocale } from "@k2b/ui";
import { For, Show } from "solid-js";
import type { WaitingAutomation } from "../code-summary";

/** Texts of the section; only the Waiting for you page carries them. */
const automationMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      heading: "Automations",
      chooseChat: "Choose a chat …",
      view: "View",
      label: ({ action, title }: { action: string; title: string }) => `${action}: ${title}`,
      failed: "Automations that need you could not be loaded.",
      retry: "Try again",
      chat_missing: "It writes nothing until you choose a chat.",
      secret: "It runs again once its secret is set.",
      mandate: "It runs again once you confirm it.",
      access: "It lacks access to one of its targets.",
    },
    de: {
      heading: "Automationen",
      chooseChat: "Chat wählen …",
      view: "Ansehen",
      label: ({ action, title }) => `${action}: ${title}`,
      failed: "Automationen, die dich brauchen, konnten nicht geladen werden.",
      retry: "Erneut versuchen",
      chat_missing: "Sie schreibt nichts, bis du einen Chat wählst.",
      secret: "Sie läuft erst wieder, wenn ihr Secret gesetzt ist.",
      mandate: "Sie läuft erst wieder, wenn du sie bestätigst.",
      access: "Ihr fehlt Zugriff auf eines ihrer Ziele.",
    },
  },
});

/**
 * "Automations" under Waiting for you: the person's own Code that waits for them, read from Core's open questions of
 * this kind alone, each row with Core's sentence, what it means and the way out. A missing chat says "Choose a chat …"
 * and leads to the Code page, where the owner chooses or restores it. `entries` null says that Core could not answer.
 */
export default function AssistantWaitingAutomations(props: { entries: readonly WaitingAutomation[] | null; onRetry: () => void }) {
  const locale = useLocale();
  const t = () => automationMessages.resolve([locale()]).t;
  const action = (entry: WaitingAutomation) => (entry.reason === "chat_missing" ? t().chooseChat : t().view);
  return (
    <section class="assistant-waiting-page__section" aria-labelledby="assistant-waiting-automations">
      <h2 id="assistant-waiting-automations" class="assistant-waiting-page__heading">
        {t().heading} <Show when={props.entries}>{(entries) => <span class="assistant-waiting-page__count">{entries().length}</span>}</Show>
      </h2>
      <Paper class="assistant-waiting-page__rows">
        <Show
          when={props.entries}
          fallback={
            <div class="assistant-waiting-page__row" role="alert">
              <span class="assistant-waiting-page__tile" aria-hidden="true">
                <i class="ti ti-cloud-off" />
              </span>
              <span class="assistant-waiting-page__row-copy">
                <span class="assistant-waiting-page__row-title">{t().failed}</span>
              </span>
              <Button type="button" size="sm" variant="secondary" onClick={() => props.onRetry()}>
                {t().retry}
              </Button>
            </div>
          }
        >
          {(entries) => (
            <ul class="assistant-waiting-page__list">
              <For each={entries()}>
                {(entry) => (
                  <li class="assistant-waiting-page__row" data-reason={entry.reason}>
                    <span class="assistant-waiting-page__tile" aria-hidden="true">
                      <FeatCodeMark variant="glyph" tone="current" size={16} decorative />
                    </span>
                    <span class="assistant-waiting-page__row-copy">
                      <span class="assistant-waiting-page__row-title">{entry.short}</span>
                      <Show when={entry.reason}>{(reason) => <span class="assistant-waiting-page__row-sub">{t()[reason()]}</span>}</Show>
                    </span>
                    <Show when={entry.href}>
                      {(href) => (
                        <ButtonLink
                          href={href()}
                          size="sm"
                          variant="secondary"
                          class="assistant-waiting-page__open"
                          aria-label={t().label({ action: action(entry), title: entry.short })}
                        >
                          {action(entry)}
                        </ButtonLink>
                      )}
                    </Show>
                  </li>
                )}
              </For>
            </ul>
          )}
        </Show>
      </Paper>
    </section>
  );
}
