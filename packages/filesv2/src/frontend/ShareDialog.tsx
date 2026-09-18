import { Button, CopyButton, dialogCore, InlineGuidance, NoticeCard, PanelDialog, panelDialogOptions, TextInput, toast } from "@k2b/ui";
import { createSignal, For, Show } from "solid-js";
import { apiClient } from "../api/client";
import type { ShareView } from "../contracts";
import { useBrowserMessages } from "./browser-messages";
import { apiFailure } from "./file-preview";
import { useFilesMessages } from "./messages";

type Validity = "1d" | "7d" | "30d" | "90d";

/** Creates a download share for entries or an upload inbox for a folder and shows the link once created. */
export function openShareDialog(options: { baseId: string; kind: "download" | "inbox"; paths?: readonly string[]; folder?: string; defaultTitle: string }) {
  return dialogCore.open<ShareView | null>((close) => <ShareForm {...options} close={close} />, panelDialogOptions);
}

function ShareForm(props: { baseId: string; kind: "download" | "inbox"; paths?: readonly string[]; folder?: string; defaultTitle: string; close: (value: ShareView | null) => void }) {
  const b = useBrowserMessages();
  const t = useFilesMessages();
  const [title, setTitle] = createSignal(props.defaultTitle);
  const [note, setNote] = createSignal("");
  const [validity, setValidity] = createSignal<Validity>("30d");
  const [busy, setBusy] = createSignal(false);
  const [created, setCreated] = createSignal<ShareView | null>(null);
  const options: { value: Validity; label: string }[] = [
    { value: "1d", label: b().oneDay },
    { value: "7d", label: b().sevenDays },
    { value: "30d", label: b().thirtyDays },
    { value: "90d", label: b().ninetyDays },
  ];
  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    if (!title().trim() || busy()) return;
    setBusy(true);
    try {
      const response = await apiClient.bases[":baseId"].shares.$post({
        param: { baseId: props.baseId },
        json: { kind: props.kind, paths: [...(props.paths ?? [])], folder: props.folder ?? "", title: title().trim(), note: note().trim() || undefined, expiresIn: validity() },
      });
      if (!response.ok) await apiFailure(response, b().shareCreateFailed);
      const share = await response.json();
      setCreated(share);
      try {
        await navigator.clipboard.writeText(share.url);
        toast.success(b().copiedLink);
      } catch {
        toast.success(b().shareCreated);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : b().shareCreateFailed);
    } finally {
      setBusy(false);
    }
  };
  return (
    <PanelDialog>
      <PanelDialog.Header
        title={props.kind === "inbox" ? b().shareInboxTitle : b().shareTitle}
        subtitle={props.defaultTitle}
        icon={props.kind === "inbox" ? "ti ti-inbox" : "ti ti-world-share"}
        close={() => props.close(created())}
      />
      <Show
        when={!created()}
        fallback={
          <>
            <PanelDialog.Body>
              <NoticeCard tone="success" title={b().shareCreated} detail={props.kind === "inbox" ? b().shareInboxScope : b().shareDownloadScope} />
              <div class="flex flex-col gap-1 text-sm">
                <span class="font-medium">{b().shareLink}</span>
                <code class="break-all rounded-md bg-[var(--k2b-surface-muted)] px-2 py-1 text-xs">{created()!.url}</code>
              </div>
              <div class="flex flex-wrap gap-2">
                <CopyButton text={created()!.url} label={b().copyLink} copiedLabel={b().copiedLink} />
                <Button variant="ghost" size="sm" onClick={() => window.open(created()!.url, "_blank", "noopener")}>
                  <i class="ti ti-external-link" aria-hidden="true" />
                  {b().openLink}
                </Button>
              </div>
            </PanelDialog.Body>
            <PanelDialog.Footer>
              <Button variant="primary" onClick={() => props.close(created())}>
                {b().close}
              </Button>
            </PanelDialog.Footer>
          </>
        }
      >
        <form onSubmit={(event) => void submit(event)} class="contents">
          <PanelDialog.Body>
            <TextInput label={b().shareName} description={b().shareNameHint} value={title} onValueChange={setTitle} required maxLength={200} />
            <fieldset class="flex flex-col gap-2">
              <legend class="text-sm font-medium">{b().shareValidity}</legend>
              <div class="flex flex-wrap gap-1" role="radiogroup" aria-label={b().shareValidity}>
                <For each={options}>
                  {(option) => (
                    <Button
                      type="button"
                      size="sm"
                      role="radio"
                      aria-checked={validity() === option.value}
                      variant={validity() === option.value ? "primary" : "secondary"}
                      onClick={() => setValidity(option.value)}
                    >
                      {option.label}
                    </Button>
                  )}
                </For>
              </div>
            </fieldset>
            <TextInput label={b().shareNote} description={b().shareNoteHint} value={note} onValueChange={setNote} maxLength={500} multiline lines={2} />
            <InlineGuidance icon="ti ti-info-circle">{props.kind === "inbox" ? b().shareInboxScope : b().shareDownloadScope}</InlineGuidance>
            <InlineGuidance icon="ti ti-users">{b().shareVisibility}</InlineGuidance>
          </PanelDialog.Body>
          <PanelDialog.Footer>
            <Button type="button" variant="ghost" onClick={() => props.close(null)}>
              {b().cancel}
            </Button>
            <Button type="submit" variant="primary" loading={busy()} disabled={!title().trim()}>
              <i class="ti ti-link" aria-hidden="true" />
              {b().createShare}
            </Button>
          </PanelDialog.Footer>
        </form>
      </Show>
    </PanelDialog>
  );
}
