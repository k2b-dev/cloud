import { IconButton, panelDialogFixedOptions, useLocale } from "@k2b/ui";
import { createMemo } from "solid-js";
import type { Mailbox } from "../../contracts";
import type { MailboxAdminSettingsContext } from "../../settings-context";
import { mailSettingsMessages } from "./mail-settings-messages";

export type ProviderSettingsProps = {
  mailbox: Mailbox;
  admin: MailboxAdminSettingsContext;
  currentUserEmail: string | null;
  reloading: boolean;
  onDirtyChange?: (dirty: boolean) => void;
  onReload: () => Promise<void>;
  onWorkspaceChange: () => void;
};

export const EditorHeading = (props: { title: string; description: string; onBack: () => void | Promise<void> }) => {
  const locale = useLocale();
  const messages = createMemo(() => mailSettingsMessages.resolve([locale()]).t);
  return (
    <div class="flex items-start gap-2">
      <IconButton type="button" class="shrink-0" label={messages().back} onClick={() => void props.onBack()}>
        <i class="ti ti-arrow-left" aria-hidden="true" />
      </IconButton>
      <div class="min-w-0">
        <h3 class="text-sm font-semibold text-primary">{props.title}</h3>
        <p class="mt-1 text-xs text-dimmed">{props.description}</p>
      </div>
    </div>
  );
};

export const connectionEditorDialogOptions = {
  ...panelDialogFixedOptions,
  cancelBehavior: "ignore" as const,
};
