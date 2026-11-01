import { Button, NoticeCard, TextInput, useLocale } from "@k2b/ui";
import { createSignal, onCleanup, Show } from "solid-js";
import type { MailboxCodeSummary } from "../../settings-context";
import { mailSettingsMessages } from "./mail-settings-messages";

type Messages = ReturnType<typeof mailSettingsMessages.resolve>["t"];

/** The mailbox's Code in one phrase, for settings and for the delete dialog. */
export const codeSummaryText = (t: Messages, code: MailboxCodeSummary): string =>
  [t.codeAutomations({ n: code.automations }), ...code.access.map((entry) => t.codeAccess({ n: entry.count, title: entry.title }))].join(
    ", ",
  );

/** What `remove` reports: `refused` proves nothing changed, `unknown` means a lost answer that may follow a committed delete. */
export type MailboxDeleteOutcome = "deleted" | "refused" | "unknown";

type MailboxDeleteDialogProps = {
  address: string;
  mails: number;
  folders: number;
  accessEntries: number;
  code: MailboxCodeSummary | null;
  remove: (signal: AbortSignal) => Promise<MailboxDeleteOutcome>;
  close: (deleted: boolean) => void;
};

/**
 * Says what goes along, in numbers, and asks for the address. Failures stay inside the dialog with the address still
 * typed, because repeating the request is safe: a mailbox that is already deleted stays deleted.
 */
export function MailboxDeleteDialog(props: MailboxDeleteDialogProps) {
  const locale = useLocale();
  const t = () => mailSettingsMessages.resolve([locale()]).t;
  const number = (value: number) => new Intl.NumberFormat(locale()).format(value);
  const [typed, setTyped] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [failure, setFailure] = createSignal<"refused" | "unknown" | null>(null);
  const abort = new AbortController();
  onCleanup(() => abort.abort());
  const matches = () => typed().trim().toLowerCase() === props.address.trim().toLowerCase();

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    if (!matches() || busy()) return;
    setBusy(true);
    setFailure(null);
    const outcome = await props.remove(abort.signal).catch((): MailboxDeleteOutcome => "unknown");
    if (abort.signal.aborted) return;
    setBusy(false);
    if (outcome === "deleted") props.close(true);
    else setFailure(outcome);
  };

  return (
    <form class="flex flex-col gap-4" onSubmit={(event) => void submit(event)}>
      <p class="text-sm">{t().deleteMailboxLead}</p>
      <ul class="grid gap-2 text-sm">
        <li class="flex items-start gap-3">
          <i class="ti ti-mail mt-0.5 text-(--k2b-text-muted)" aria-hidden="true" />
          <span>{t().deleteCascadeMail({ mails: number(props.mails), folders: number(props.folders) })}</span>
        </li>
        <li class="flex items-start gap-3">
          <i class="ti ti-users mt-0.5 text-(--k2b-text-muted)" aria-hidden="true" />
          <span>{t().deleteCascadeAccess({ entries: number(props.accessEntries) })}</span>
        </li>
        <Show when={props.code?.exists !== false}>
          <li class="flex items-start gap-3 font-medium" data-cascade="code">
            <i class="ti ti-code mt-0.5 text-(--k2b-danger-600)" aria-hidden="true" />
            <span>{props.code ? t().deleteCascadeCode({ detail: codeSummaryText(t(), props.code) }) : t().deleteCascadeCodeUnknown}</span>
          </li>
        </Show>
      </ul>
      <Show when={props.code?.exists !== false}>
        <p class="text-xs text-(--k2b-text-muted)">{t().deleteCodeKeeps}</p>
      </Show>
      <Show when={failure()}>
        {(kind) => (
          <NoticeCard
            tone="danger"
            icon="ti ti-alert-triangle"
            title={t().deleteFailedTitle}
            detail={kind() === "refused" ? t().deleteFailedBody : t().deleteUnknownBody}
          />
        )}
      </Show>
      <TextInput
        label={t().deleteConfirmLabel}
        placeholder={props.address}
        value={typed}
        onValueChange={setTyped}
        autocomplete="off"
        autocapitalize="off"
        spellcheck={false}
        monospace
        required
      />
      <div class="flex items-center justify-end gap-2">
        <Button variant="secondary" size="sm" type="button" onClick={() => props.close(false)}>
          {t().deleteCancel}
        </Button>
        <Button variant="danger" size="sm" type="submit" disabled={!matches()} loading={busy()}>
          <i class="ti ti-trash" aria-hidden="true" />
          {t().moveToRecentlyDeleted}
        </Button>
      </div>
    </form>
  );
}
