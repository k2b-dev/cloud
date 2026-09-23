import { CONTACT_DIRECTORY_FUNCTIONS, type ContactDirectoryFunction } from "@k2b/cloud/contracts";
import { mutation } from "@k2b/stdlib/solid";
import {
  Button,
  confirmDiscardIfDirty,
  dialogCore,
  LocaleProvider,
  NoticeCard,
  PanelDialog,
  panelDialogOptions,
  Select,
  type SelectSourceOption,
  toast,
  useLocale,
} from "@k2b/ui";
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { createStore, unwrap } from "solid-js/store";
import { apiClient } from "../../api/client";
import { contactDirectoryMessages } from "../../contact-directory-messages";
import {
  MAIL_CONTACT_DIRECTORY_DEFAULTS,
  MAIL_CONTACT_DIRECTORY_REQUIRED,
  type MailContactDirectoryConfig,
  proposeContactDirectoryConfig,
} from "../../contact-directory-settings";
import type { ContactDirectoryAdminView, ContactDirectoryField, ContactDirectoryIssue } from "../../service/contact-directory";
import { readApiError } from "./api-response";

const fieldId = (field: ContactDirectoryField) => `mail-contact-directory-${field}`;
const isRequired = (fn: ContactDirectoryFunction) => MAIL_CONTACT_DIRECTORY_REQUIRED.some((required) => required === fn);
const sameConfig = (left: MailContactDirectoryConfig, right: MailContactDirectoryConfig) =>
  (["appId", ...CONTACT_DIRECTORY_FUNCTIONS] as const).every((field) => left[field] === right[field]);

type ContactDirectoryFormProps = {
  view: ContactDirectoryAdminView;
  close: (saved?: MailContactDirectoryConfig) => void;
  setDismissHandler: (handler: () => void | Promise<void>) => void;
};

function ContactDirectoryForm(props: ContactDirectoryFormProps) {
  const locale = useLocale();
  const t = createMemo(() => contactDirectoryMessages.resolve([locale()]).t);
  const initial = { ...props.view.config };
  const [config, setConfig] = createStore<MailContactDirectoryConfig>({ ...initial });
  const [issues, setIssues] = createSignal<ContactDirectoryIssue[]>(props.view.issues);
  const [savedIssuesVisible, setSavedIssuesVisible] = createSignal(props.view.issues.length > 0);
  const apps = () => props.view.apps ?? [];
  const catalogAvailable = () => props.view.apps !== null;
  const selectedApp = createMemo(() => apps().find((app) => app.appId === config.appId));
  const fieldError = (field: ContactDirectoryField) => issues().find((issue) => issue.field === field)?.message;

  const appOptions = createMemo((): SelectSourceOption[] => [
    ...apps().map((app) => ({ id: app.appId, label: app.appName, description: app.appId, icon: app.appIcon || "ti ti-apps" })),
    ...(config.appId && !selectedApp()
      ? [{ id: config.appId, label: t().appUnavailable({ appId: config.appId }), icon: "ti ti-apps-off" }]
      : []),
  ]);

  const capabilityOptions = (fn: ContactDirectoryFunction): SelectSourceOption[] => {
    const compatible = selectedApp()?.capabilities[fn] ?? [];
    const current = config[fn];
    return [
      ...compatible.map((option) => ({ id: option.id, label: option.title, description: option.id })),
      ...(current && !compatible.some((option) => option.id === current)
        ? [{ id: current, label: current, description: t().currentValue }]
        : []),
    ];
  };

  const chooseApp = (appId: string | null) => {
    if (!appId || appId === config.appId) return;
    setConfig(proposeContactDirectoryConfig(appId, apps().find((entry) => entry.appId === appId)?.capabilities));
    setIssues([]);
  };

  const focusFirstIssue = (found: ContactDirectoryIssue[]) => {
    const first = found[0];
    if (first) queueMicrotask(() => document.getElementById(fieldId(first.field))?.focus());
  };

  const save = mutation.create<MailContactDirectoryConfig, MailContactDirectoryConfig>({
    mutation: async (value, { abortSignal }) => {
      setIssues([]);
      setSavedIssuesVisible(false);
      const response = await apiClient.admin["contact-directory"].$put({ json: value }, { init: { signal: abortSignal } });
      if (response.status === 400) {
        const body = await response.json();
        if ("issues" in body) setIssues(body.issues);
        throw new Error(body.message);
      }
      if (!response.ok) throw new Error(await readApiError(response, t().saveFailed));
      return response.json();
    },
    onSuccess: (saved) => {
      toast.success(t().saved);
      props.close(saved);
    },
    onError: (error) => {
      // Focus once the mutation settles; the fields are disabled while it is loading.
      if (issues().length > 0) focusFirstIssue(issues());
      else void toast.error(error.message || t().saveFailed);
    },
  });
  onCleanup(() => save.abort());

  const disabled = () => save.loading() || !catalogAvailable();
  const requestClose = async () => {
    if (save.loading()) return;
    if (await confirmDiscardIfDirty(() => !sameConfig(unwrap(config), initial))) props.close();
  };
  props.setDismissHandler(requestClose);

  const functionField = (fn: ContactDirectoryFunction) => (
    <Select
      id={fieldId(fn)}
      label={t()[fn]}
      description={t()[`${fn}Description`]}
      required={isRequired(fn)}
      clearable={!isRequired(fn)}
      placeholder={capabilityOptions(fn).length === 0 ? t().noCompatibleCapability : isRequired(fn) ? t().chooseCapability : t().notUsed}
      options={capabilityOptions(fn)}
      value={() => config[fn] || null}
      onValueChange={(value) => {
        setConfig(fn, value ?? "");
        setIssues((current) => current.filter((issue) => issue.field !== fn));
      }}
      error={() => fieldError(fn)}
      disabled={disabled()}
    />
  );

  return (
    <form
      class="contents"
      onSubmit={(event) => {
        event.preventDefault();
        if (!disabled()) save.mutate({ ...unwrap(config) });
      }}
    >
      <PanelDialog>
        <PanelDialog.Header
          title={t().title}
          subtitle={t().description}
          icon="ti ti-address-book"
          close={() => void requestClose()}
          closeDisabled={save.loading()}
          closeLabel={t().cancel}
        />
        <PanelDialog.Body scrollPreserveKey="mail-admin-contact-directory">
          <div class="grid gap-4">
            <Show when={!catalogAvailable()}>
              <NoticeCard tone="warning" role="status">
                {t().catalogUnavailable}
              </NoticeCard>
            </Show>
            <Show when={savedIssuesVisible() && issues().length > 0 && !save.error()}>
              <NoticeCard tone="warning" title={t().currentMappingProblem} role="status">
                <ul class="list-disc pl-4">
                  <For each={issues()}>{(issue) => <li>{issue.message}</li>}</For>
                </ul>
              </NoticeCard>
            </Show>
            <Show when={save.error() && issues().length > 0}>
              <NoticeCard tone="danger" title={t().fixBeforeSaving} role="alert">
                <ul class="list-disc pl-4">
                  <For each={issues()}>{(issue) => <li>{issue.message}</li>}</For>
                </ul>
              </NoticeCard>
            </Show>
            <Select
              id={fieldId("appId")}
              label={t().app}
              description={t().appDescription}
              required
              placeholder={t().chooseApp}
              options={appOptions()}
              value={() => config.appId || null}
              onValueChange={chooseApp}
              error={() => fieldError("appId")}
              disabled={disabled()}
            />
            <For each={CONTACT_DIRECTORY_FUNCTIONS}>{(fn) => functionField(fn)}</For>
          </div>
        </PanelDialog.Body>
        <PanelDialog.Footer>
          <Button
            variant="subtle"
            size="sm"
            type="button"
            disabled={disabled()}
            onClick={() => {
              setConfig({ ...MAIL_CONTACT_DIRECTORY_DEFAULTS });
              setIssues([]);
            }}
          >
            <i class="ti ti-restore" aria-hidden="true" /> {t().reset}
          </Button>
          <div class="flex items-center gap-2">
            <Button variant="secondary" size="sm" type="button" disabled={save.loading()} onClick={() => void requestClose()}>
              {t().cancel}
            </Button>
            <Button size="sm" type="submit" disabled={disabled()}>
              <i class={`ti ${save.loading() ? "ti-loader-2 animate-spin" : "ti-device-floppy"}`} aria-hidden="true" />
              {t().save}
            </Button>
          </div>
        </PanelDialog.Footer>
      </PanelDialog>
    </form>
  );
}

/**
 * Opens the contact-directory editor. Resolves with the stored mapping after a
 * successful save, or `undefined` when the administrator closes the dialog.
 */
export const openMailContactDirectoryDialog = (view: ContactDirectoryAdminView, locale: string) =>
  dialogCore.open<MailContactDirectoryConfig>(
    (close, dialog) => (
      <LocaleProvider locale={locale}>
        <ContactDirectoryForm view={view} close={close} setDismissHandler={dialog.setDismissHandler} />
      </LocaleProvider>
    ),
    panelDialogOptions,
  );
