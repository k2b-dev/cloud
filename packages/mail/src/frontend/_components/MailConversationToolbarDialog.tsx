import { Button, CheckboxCard, prompts, useLocale } from "@k2b/ui";
import { createMemo, createSignal, For } from "solid-js";
import {
  getMailConversationToolbarSections,
  MAX_MAIL_CONVERSATION_TOOLBAR_ACTIONS,
  type MailConversationToolbarActionId,
  normalizeMailConversationToolbarActions,
} from "./mail-conversation-toolbar";
import { mailConversationUiMessages } from "./mail-conversation-ui-messages";

export const openMailConversationToolbarDialog = (
  current: readonly MailConversationToolbarActionId[],
): Promise<MailConversationToolbarActionId[] | undefined> => {
  const locale = useLocale();
  const t = createMemo(() => mailConversationUiMessages.resolve([locale()]).t);
  return prompts.dialog<MailConversationToolbarActionId[]>(
    (close) => {
      const [selected, setSelected] = createSignal(normalizeMailConversationToolbarActions(current));
      const toggle = (actionId: MailConversationToolbarActionId, enabled: boolean) => {
        setSelected((existing) =>
          enabled
            ? normalizeMailConversationToolbarActions([...existing, actionId])
            : existing.filter((candidate) => candidate !== actionId),
        );
      };

      return (
        <div class="flex min-h-0 flex-col gap-4">
          <div>
            <p class="text-sm text-secondary">{t().toolbarHint({ count: MAX_MAIL_CONVERSATION_TOOLBAR_ACTIONS })}</p>
            <p class="mt-1 text-xs text-dimmed">{t().toolbarOrderHint}</p>
          </div>
          <div class="flex min-h-0 flex-col gap-4 overflow-y-auto">
            <For each={getMailConversationToolbarSections(locale())}>
              {(section) => (
                <section class="flex flex-col gap-2">
                  <p class="section-label">{section.label}</p>
                  <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <For each={section.options}>
                      {(option) => {
                        const checked = () => selected().includes(option.id);
                        return (
                          <CheckboxCard
                            label={option.label}
                            description={option.description}
                            icon={option.icon}
                            value={checked}
                            disabled={!checked() && selected().length >= MAX_MAIL_CONVERSATION_TOOLBAR_ACTIONS}
                            onValueChange={(enabled) => toggle(option.id, enabled)}
                          />
                        );
                      }}
                    </For>
                  </div>
                </section>
              )}
            </For>
          </div>
          <div class="flex items-center justify-between gap-2">
            <span class="text-xs tabular-nums text-dimmed">
              {t().selectedCount({ selected: selected().length, total: MAX_MAIL_CONVERSATION_TOOLBAR_ACTIONS })}
            </span>
            <div class="flex items-center gap-2">
              <Button variant="secondary" size="sm" type="button" onClick={() => close(undefined)}>
                {t().cancel}
              </Button>
              <Button size="sm" type="button" onClick={() => close(selected())}>
                {t().saveToolbar}
              </Button>
            </div>
          </div>
        </div>
      );
    },
    { title: t().customizeToolbar, icon: "ti ti-adjustments-horizontal", size: "large" },
  );
};
