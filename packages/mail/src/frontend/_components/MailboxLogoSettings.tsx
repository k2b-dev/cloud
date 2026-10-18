import { toBase64 } from "@k2b/stdlib";
import { mutation as mutations, query } from "@k2b/stdlib/solid";
import {
  Button,
  FileDropzone,
  InlineGuidance,
  NumberInput,
  Paper,
  Placeholder,
  prompts,
  SettingsGroup,
  TextInput,
  toast,
  useLocale,
} from "@k2b/ui";
import { createEffect, createMemo, createSignal, createUniqueId, Match, on, onCleanup, Switch } from "solid-js";
import { apiClient } from "../../api/client";
import { type MailboxComposeLogo, mailboxLogoDisplayHeight } from "../../contracts";
import { readApiError } from "./api-response";
import { mailSettingsMessages } from "./mail-settings-messages";

type Logo = NonNullable<MailboxComposeLogo["logo"]>;
type LogoUpload = { content: string; displayWidth?: number; altText?: string };

/** The largest file the server accepts; larger files are not read or sent. */
const MAX_LOGO_BYTES = 102_400;
const DEFAULT_DISPLAY_WIDTH = 200;

/** The stored bytes of a logo, as the server sent them: its data URL already carries canonical padded base64. */
const storedContent = (logo: Logo): string => logo.dataUrl.slice(logo.dataUrl.indexOf(",") + 1);

/**
 * The mailbox logo that `{{ mailbox.logo }}` places in signatures. Mailbox admins upload, replace, adjust, and remove it;
 * people with write access see the same values with every control disabled. The server checks the file and the right.
 */
export default function MailboxLogoSettings(props: { mailboxId: string; canManage: boolean }) {
  const locale = useLocale();
  const messages = createMemo(() => mailSettingsMessages.resolve([locale()]).t);
  const id = createUniqueId();
  const dropzoneId = `mail-logo-file-${id}`;
  const altTextId = `mail-logo-alt-${id}`;
  const logoQuery = query.create({
    source: () => props.mailboxId,
    load: async (mailboxId, { abortSignal }) => {
      const response = await apiClient.mailboxes[":mailboxId"]["compose-logo"].$get(
        { param: { mailboxId } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, messages().failedLoadLogo));
      return response.json();
    },
  });
  // `undefined` until the first load answers; `null` when the mailbox has no logo.
  const [logo, setLogo] = createSignal<Logo | null | undefined>(undefined);
  createEffect(on(logoQuery.data, (data) => data && setLogo(data.logo)));
  const [displayWidth, setDisplayWidth] = createSignal<number | null>(DEFAULT_DISPLAY_WIDTH);
  const [altText, setAltText] = createSignal("");
  createEffect(
    on(logo, (current) => {
      setDisplayWidth(current?.displayWidth ?? DEFAULT_DISPLAY_WIDTH);
      setAltText(current?.altText ?? "");
    }),
  );
  const [uploadError, setUploadError] = createSignal<string>();
  const [detailsError, setDetailsError] = createSignal<string>();

  // Saving disables the control that started it; focus returns to a control that stays.
  const focusControl = (controlId: string) => queueMicrotask(() => document.getElementById(controlId)?.focus());

  const putLogo = async (json: LogoUpload, abortSignal: AbortSignal) => {
    const response = await apiClient.mailboxes[":mailboxId"]["compose-logo"].$put(
      { param: { mailboxId: props.mailboxId }, json },
      { init: { signal: abortSignal } },
    );
    if (!response.ok) throw new Error(await readApiError(response, messages().failedSaveLogo));
    return (await response.json()).logo;
  };
  // A cancelled save (the settings closed meanwhile) reaches neither handler, so it never reports success.
  const upload = mutations.create<Logo | null, LogoUpload>({
    mutation: (json, { abortSignal }) => putLogo(json, abortSignal),
    onSuccess: (next) => {
      setLogo(next);
      setDetailsError();
      toast.success(messages().logoUploaded);
      focusControl(dropzoneId);
    },
    onError: (error) => {
      setUploadError(error.message);
      focusControl(dropzoneId);
    },
  });
  const saveDetails = mutations.create<Logo | null, LogoUpload>({
    mutation: (json, { abortSignal }) => putLogo(json, abortSignal),
    onSuccess: (next) => {
      setLogo(next);
      toast.success(messages().logoDetailsSaved);
      focusControl(altTextId);
    },
    onError: (error) => {
      setDetailsError(error.message);
      focusControl(altTextId);
    },
  });
  const remove = mutations.create<void, void>({
    mutation: async (_input, { abortSignal }) => {
      const response = await apiClient.mailboxes[":mailboxId"]["compose-logo"].$delete(
        { param: { mailboxId: props.mailboxId } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, messages().failedRemoveLogo));
    },
    onSuccess: () => {
      setLogo(null);
      setUploadError();
      setDetailsError();
      toast.success(messages().logoRemoved);
      focusControl(dropzoneId);
    },
    onError: (error) => prompts.error(error.message),
  });
  onCleanup(() => {
    upload.abort();
    saveDetails.abort();
    remove.abort();
  });

  const busy = () => upload.loading() || saveDetails.loading() || remove.loading();
  const loaded = () => logo() !== undefined;
  const editable = () => props.canManage && loaded() && !busy();
  const detailsEditable = () => editable() && Boolean(logo());
  const trimmedAlt = () => altText().trim();
  const detailsDirty = () => {
    const current = logo();
    return Boolean(current) && (displayWidth() !== current?.displayWidth || trimmedAlt() !== current?.altText);
  };

  const chooseFile = async (file: File | undefined) => {
    if (!file) return;
    setUploadError();
    if (file.size > MAX_LOGO_BYTES) {
      setUploadError(messages().logoTooLarge);
      return;
    }
    let content: string;
    try {
      content = toBase64(new Uint8Array(await file.arrayBuffer()));
    } catch {
      setUploadError(messages().logoReadFailed);
      return;
    }
    // A replacement keeps the stored width and alt text; a first upload takes the server's defaults.
    const current = logo();
    await upload.mutate(current ? { content, displayWidth: current.displayWidth, altText: current.altText } : { content });
  };

  const submitDetails = async () => {
    const current = logo();
    const width = displayWidth();
    if (!current || width === null) return;
    if (!trimmedAlt()) {
      setDetailsError(messages().logoAltTextRequired);
      return;
    }
    setDetailsError();
    // Versions are immutable: a new width or alt text stores the same bytes again.
    await saveDetails.mutate({ content: storedContent(current), displayWidth: width, altText: trimmedAlt() });
  };

  const confirmRemove = async () => {
    const confirmed = await prompts.confirm(messages().removeLogoDescription, {
      title: messages().removeLogoTitle,
      confirmText: messages().removeLogo,
      variant: "danger",
    });
    if (confirmed) await remove.mutate();
  };

  return (
    <SettingsGroup title={messages().logo} description={messages().logoDescription}>
      <div class="flex flex-col gap-3">
        <div class="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,15rem)]">
          {/* One fixed box for every state; the logo's box comes from its stored size, so nothing moves while it loads. */}
          {/* The logo sits on the white paper recipients see, also in dark mode. */}
          <Paper
            class="flex h-44 min-w-0 items-center justify-center overflow-hidden"
            style={{ "background-color": logo() ? "#fff" : undefined }}
            data-mail-logo-stage
          >
            <Switch>
              <Match when={logo()}>
                {(current) => (
                  <img
                    src={current().dataUrl}
                    alt={current().altText}
                    title={messages().logoPreview}
                    width={current().displayWidth}
                    height={mailboxLogoDisplayHeight(current())}
                    class="block max-h-[calc(100%-2rem)] max-w-[calc(100%-2rem)] object-contain"
                    // The stored pixel size, not the rounded height, keeps the box identical before and after the image loads.
                    style={{ height: "auto", "aspect-ratio": `${current().pixelWidth} / ${current().pixelHeight}` }}
                  />
                )}
              </Match>
              <Match when={logo() === null}>
                <Placeholder icon="ti ti-photo" title={messages().noLogo} description={messages().noLogoDescription} />
              </Match>
              <Match when={logoQuery.error() && !logoQuery.loading()}>
                <Placeholder
                  state="error"
                  title={messages().failedLoadLogo}
                  description={logoQuery.error()?.message === messages().failedLoadLogo ? undefined : logoQuery.error()?.message}
                  action={
                    <Button variant="secondary" size="sm" type="button" onClick={() => void logoQuery.refresh()}>
                      <i class="ti ti-refresh" aria-hidden="true" />
                      {messages().retry}
                    </Button>
                  }
                />
              </Match>
              <Match when={true}>
                <Placeholder state="loading" title={messages().loadingLogo} />
              </Match>
            </Switch>
          </Paper>
          <FileDropzone
            id={dropzoneId}
            aria-label={logo() ? messages().replaceLogo : messages().uploadLogo}
            accept="image/png,image/jpeg,.png,.jpg,.jpeg"
            multiple={false}
            icon="ti ti-photo-up"
            title={logo() ? messages().replaceLogo : messages().uploadLogo}
            subtitle={messages().logoLimits}
            dropLabel={messages().dropLogo}
            class="sm:[&_.k2b-dropzone]:h-44"
            busy={upload.loading()}
            disabled={!editable()}
            error={uploadError}
            onDrop={([file]) => chooseFile(file)}
          />
        </div>
        <div class="grid gap-3 sm:grid-cols-2">
          <NumberInput
            label={messages().logoDisplayWidth}
            description={messages().logoDisplayWidthDescription}
            value={displayWidth}
            onValueChange={setDisplayWidth}
            min={1}
            max={600}
            allowNegative={false}
            suffix="px"
            disabled={!detailsEditable()}
          />
          <TextInput
            id={altTextId}
            label={messages().logoAltText}
            description={messages().logoAltTextDescription}
            value={altText}
            onValueChange={setAltText}
            maxLength={200}
            required
            disabled={!detailsEditable()}
            error={detailsError}
          />
        </div>
        <div class="flex flex-wrap items-center justify-between gap-2">
          {props.canManage ? <span /> : <InlineGuidance icon="ti ti-lock">{messages().logoAdminOnly}</InlineGuidance>}
          <div class="flex items-center gap-2">
            <Button variant="ghost" size="sm" type="button" disabled={!detailsEditable()} onClick={() => void confirmRemove()}>
              <i class={`ti ${remove.loading() ? "ti-loader-2 animate-spin" : "ti-trash"}`} aria-hidden="true" />
              {messages().removeLogo}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              type="button"
              disabled={!detailsEditable() || !detailsDirty() || displayWidth() === null}
              onClick={() => void submitDetails()}
            >
              <i class={`ti ${saveDetails.loading() ? "ti-loader-2 animate-spin" : "ti-device-floppy"}`} aria-hidden="true" />
              {messages().saveLogoDetails}
            </Button>
          </div>
        </div>
      </div>
    </SettingsGroup>
  );
}
