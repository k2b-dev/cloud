import { CONTACT_DIRECTORY_FUNCTIONS, type ContactDirectoryFunction } from "@k2b/cloud/contracts";
import { mutation } from "@k2b/stdlib/solid";
import { Button, NoticeCard, Select, type SelectSourceOption, toast, useLocale } from "@k2b/ui";
import { createMemo, createSignal, For, Show } from "solid-js";
import { createStore } from "solid-js/store";
import { apiClient } from "../../api/client";
import { contactDirectoryMessages } from "../../contact-directory-messages";
import {
  MAIL_CONTACT_DIRECTORY_DEFAULTS,
  MAIL_CONTACT_DIRECTORY_REQUIRED,
  type MailContactDirectoryConfig,
} from "../../contact-directory-settings";
import type { ContactDirectoryAppOption, ContactDirectoryField, ContactDirectoryIssue } from "../../service/contact-directory";
import { readApiError } from "./api-response";

const fieldId = (field: ContactDirectoryField) => `mail-contact-directory-${field}`;
const isRequired = (fn: ContactDirectoryFunction) => MAIL_CONTACT_DIRECTORY_REQUIRED.some((required) => required === fn);

/** Prefill a function for a newly chosen app: the Contacts default ID if compatible, otherwise the only compatible choice. */
const prefill = (app: ContactDirectoryAppOption | undefined, fn: ContactDirectoryFunction): string => {
  const options = app?.capabilities[fn] ?? [];
  if (options.some((option) => option.id === MAIL_CONTACT_DIRECTORY_DEFAULTS[fn])) return MAIL_CONTACT_DIRECTORY_DEFAULTS[fn];
  return options.length === 1 && options[0] ? options[0].id : "";
};

export default function MailAdminContactDirectory(props: {
  apps: ContactDirectoryAppOption[] | null;
  config: MailContactDirectoryConfig;
  issues: ContactDirectoryIssue[];
}) {
  const locale = useLocale();
  const t = createMemo(() => contactDirectoryMessages.resolve([locale()]).t);
  const [config, setConfig] = createStore<MailContactDirectoryConfig>({ ...props.config });
  const [issues, setIssues] = createSignal<ContactDirectoryIssue[]>(props.issues);
  const [savedIssuesVisible, setSavedIssuesVisible] = createSignal(props.issues.length > 0);
  const apps = () => props.apps ?? [];
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
    const app = apps().find((entry) => entry.appId === appId);
    setConfig({
      appId,
      suggest: prefill(app, "suggest"),
      resolve: prefill(app, "resolve"),
      read: prefill(app, "read"),
      listWritableBooks: prefill(app, "listWritableBooks"),
      create: prefill(app, "create"),
    });
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
        if ("issues" in body) {
          setIssues(body.issues);
          focusFirstIssue(body.issues);
        }
        throw new Error(body.message);
      }
      if (!response.ok) throw new Error(await readApiError(response, t().saveFailed));
      return response.json();
    },
    onSuccess: (saved) => {
      setConfig({ ...saved });
      setIssues([]);
      setSavedIssuesVisible(false);
      toast.success(t().saved);
    },
    onError: (error) => {
      if (issues().length === 0) void toast.error(error.message || t().saveFailed);
    },
  });

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
      disabled={save.loading() || !props.apps}
    />
  );

  return (
    <section class="paper flex w-full max-w-2xl flex-col gap-4 p-4 sm:p-6" aria-labelledby="mail-contact-directory-form-title">
      <h2 id="mail-contact-directory-form-title" class="sr-only">
        {t().title}
      </h2>
      <Show when={!props.apps}>
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
        disabled={save.loading() || !props.apps}
      />
      <For each={CONTACT_DIRECTORY_FUNCTIONS}>{(fn) => functionField(fn)}</For>
      <div class="flex flex-wrap items-center justify-between gap-2">
        <Button
          variant="secondary"
          size="sm"
          type="button"
          disabled={save.loading() || !props.apps}
          onClick={() => {
            setConfig({ ...MAIL_CONTACT_DIRECTORY_DEFAULTS });
            setIssues([]);
          }}
        >
          {t().reset}
        </Button>
        <Button size="sm" type="button" disabled={save.loading() || !props.apps} onClick={() => save.mutate({ ...config })}>
          <i class={`ti ${save.loading() ? "ti-loader-2 animate-spin" : "ti-device-floppy"}`} aria-hidden="true" />
          {t().save}
        </Button>
      </div>
    </section>
  );
}
