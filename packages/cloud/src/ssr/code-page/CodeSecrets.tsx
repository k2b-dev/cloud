import { documentNavigate, refreshCurrentPath } from "@k2b/ssr/nav";
import { dates } from "@k2b/stdlib";
import { Button, NoticeCard, Placeholder, prompts, StatusBadge, TextInput, toast, useLocale } from "@k2b/ui";
import { createMemo, createSignal, For, type JSX, onCleanup, Show } from "solid-js";
import { z } from "zod";
import { invokeCapabilityWithDataSchema } from "../../capabilities/client";
import { CodeSecretBindingSchema, CodeSecretNameSchema, codeSecretPlaceholder } from "../../contracts/code-secrets";
import { type CodePageData, type CodePageReady, type CodePageSecret, SecretSetSchema, wrapped } from "./data";
import { type CodePageMessages, codePageMessages } from "./messages";

/** Same-origin Core routes the CLI uses too; a check against a Runner may outlast an ordinary capability call. */
const authoring = async <T extends z.ZodType>(
  command: "secretCheck" | "resubmit",
  body: unknown,
  schema: T,
): Promise<{ ok: true; data: z.output<T> } | { ok: false; status: number | null }> => {
  try {
    const response = await fetch(`/api/code/authoring/${command}`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) return { ok: false, status: response.status };
    const parsed = schema.safeParse(await response.json());
    return parsed.success ? { ok: true, data: parsed.data } : { ok: false, status: null };
  } catch {
    return { ok: false, status: null };
  }
};
const AllowedSchema = z.object({ allowed: z.boolean() });
const SubmittedSchema = z.object({ submission: z.object({ version: z.object({ number: z.number() }) }) });
const DeletedSchema = wrapped(z.object({ deleted: z.boolean() }));

const pageUrl = (data: CodePageData, params: Record<string, string>) =>
  `${data.href}?${new URLSearchParams({ tab: "secrets", ...params }).toString()}`;

/** Core's value contract: printable text for a request header. */
const valueAllowed = (value: string) => /^[\x20-\x7e]+$/.test(value);

/** Accepts a trailing slash and upper case in a host, since the stored form is exact. */
const normalizedOrigin = (text: string) => {
  try {
    const url = new URL(text.trim());
    return url.pathname === "/" && !url.search && !url.hash ? url.origin : text.trim();
  } catch {
    return text.trim();
  }
};
type BindingDraft = { origin: string; path: string; header: string };
type BindingErrors = Partial<Record<keyof BindingDraft, string>>;
const parseBinding = (draft: BindingDraft) =>
  CodeSecretBindingSchema.safeParse({
    origin: normalizedOrigin(draft.origin),
    pathPrefix: draft.path.trim(),
    headers: draft.header
      .split(",")
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean),
  });
const bindingErrors = (draft: BindingDraft, t: CodePageMessages): BindingErrors => {
  const parsed = parseBinding(draft);
  if (parsed.success) return {};
  const fields = new Set(parsed.error.issues.map((issue) => issue.path[0]));
  return {
    origin: fields.has("origin") ? t.secretOriginFormat : undefined,
    path: fields.has("pathPrefix") ? t.secretPathInvalid : undefined,
    header: fields.has("headers") ? t.secretHeaderInvalid : undefined,
  };
};

/** Writes through Core's editor capability. It takes no idempotency key, so nothing keeps a digest of the value. */
const writeSecret = (codeId: string, input: { name: string; value: string; binding_revision: string | null; binding?: unknown }) =>
  invokeCapabilityWithDataSchema(
    { appId: "core", capabilityId: "code.secret.set", kind: "action", target: { type: "core.code", id: codeId }, input },
    wrapped(SecretSetSchema),
  );
const writeFailure = (status: number, t: CodePageMessages) =>
  status === 409 ? t.secretNameTaken : status === 403 ? t.secretSetRefused : status >= 500 ? t.secretSetUnknown : t.secretSetFailed;

/** Asks Core whether this address may receive a credential, before any value travels. */
const checkDestination = async (codeId: string, binding: unknown) => {
  const checked = await authoring("secretCheck", { codeId, binding }, AllowedSchema);
  return checked.ok ? checked.data.allowed : null;
};
/** A changed destination reaches a version only by submitting one; the outcome shows on the reloaded page. */
const submitAndShow = async (data: CodePageData, state: CodePageReady, name: string) => {
  const latest = state.secrets?.latest;
  if (!latest) return documentNavigate(pageUrl(data, { secret: name, notice: "saved" }));
  const submitted = await authoring("resubmit", { codeId: state.code.id, baseVersionId: latest.id }, SubmittedSchema);
  documentNavigate(pageUrl(data, { secret: name, notice: submitted.ok ? "submitted" : "submit-failed" }));
};

function ValueField(props: { t: CodePageMessages; value: string; onInput: (value: string) => void; error?: string; hint?: string }) {
  return (
    <TextInput
      label={props.t.secretValue}
      description={props.hint ?? props.t.secretValueHint}
      password
      icon={false}
      autocomplete="new-password"
      spellcheck={false}
      required
      value={props.value}
      onValueChange={props.onInput}
      error={props.error}
    />
  );
}
function BindingFields(props: {
  t: CodePageMessages;
  draft: BindingDraft;
  onInput: (field: keyof BindingDraft, value: string) => void;
  errors: BindingErrors;
}) {
  return (
    <>
      <div class="cloud-code__secret-fields">
        <TextInput
          label={props.t.secretOrigin}
          type="url"
          monospace
          icon={false}
          required
          spellcheck={false}
          placeholder="https://api.example.com"
          value={props.draft.origin}
          onValueChange={(value) => props.onInput("origin", value)}
          error={props.errors.origin}
        />
        <TextInput
          label={props.t.secretPath}
          monospace
          icon={false}
          required
          spellcheck={false}
          value={props.draft.path}
          onValueChange={(value) => props.onInput("path", value)}
          error={props.errors.path}
        />
      </div>
      <TextInput
        label={props.t.secretHeader}
        monospace
        icon={false}
        required
        spellcheck={false}
        value={props.draft.header}
        onValueChange={(value) => props.onInput("header", value)}
        error={props.errors.header}
      />
    </>
  );
}

function NewBindingNote(props: { t: CodePageMessages; state: CodePageReady }) {
  const next = () => (props.state.secrets?.latest ? props.state.secrets.latest.number + 1 : null);
  return (
    <NoticeCard
      tone="warning"
      icon="ti ti-user-shield"
      title={props.t.secretNewBindingTitle({ version: next() })}
      detail={next() === null ? undefined : props.t.secretNewBindingDetail({ running: props.state.active?.number ?? null })}
    />
  );
}

function CreateDialog(props: { data: CodePageData; state: CodePageReady; t: CodePageMessages; close: () => void }) {
  const t = props.t;
  const [name, setName] = createSignal("");
  const [draft, setDraft] = createSignal<BindingDraft>({ origin: "", path: "/", header: "Authorization" });
  const [value, setValue] = createSignal("");
  const [errors, setErrors] = createSignal<BindingErrors & { name?: string; value?: string }>({});
  const [refused, setRefused] = createSignal<string | null>(null);
  const [failure, setFailure] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  // Cancelling during the address check stops the write.
  let closed = false;
  onCleanup(() => {
    closed = true;
  });
  const submit = async () => {
    if (busy()) return;
    setFailure(null);
    const next = {
      ...bindingErrors(draft(), t),
      name: CodeSecretNameSchema.safeParse(name().trim()).success ? undefined : t.secretNameInvalid,
      value: valueAllowed(value()) ? undefined : t.secretValueInvalid,
    };
    setErrors(next);
    const binding = parseBinding(draft());
    if (Object.values(next).some(Boolean) || !binding.success) return;
    // Everything sent is taken now, together: typing during the check cannot pair a new value with an old address.
    const origin = draft().origin;
    const sent = value();
    const secretName = name().trim();
    setBusy(true);
    const allowed = await checkDestination(props.state.code.id, binding.data);
    if (allowed === null) {
      setBusy(false);
      return setFailure(t.secretCheckFailed);
    }
    if (!allowed) {
      setBusy(false);
      setRefused(origin);
      return;
    }
    if (closed) return;
    // From here the value has left the form: it does not stay in client state, whatever Core answers.
    setValue("");
    const written = await writeSecret(props.state.code.id, {
      name: secretName,
      value: sent,
      binding_revision: null,
      binding: binding.data,
    });
    if (!written.ok) {
      setBusy(false);
      return setFailure(writeFailure(written.error.status, t));
    }
    await submitAndShow(props.data, props.state, secretName);
    props.close();
  };
  const originError = () => (refused() === draft().origin ? t.secretOriginInvalid : errors().origin);
  return (
    <form
      class="cloud-code__secret-form"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <TextInput
        label={t.secretName}
        description={t.secretNameHint}
        monospace
        icon={false}
        required
        spellcheck={false}
        value={name()}
        onValueChange={setName}
        error={errors().name}
      />
      <BindingFields
        t={t}
        draft={draft()}
        onInput={(field, text) => setDraft({ ...draft(), [field]: text })}
        errors={{ ...errors(), origin: originError() }}
      />
      <ValueField t={t} value={value()} onInput={setValue} error={errors().value} />
      <NewBindingNote t={t} state={props.state} />
      <Show when={failure()}>{(text) => <NoticeCard tone="danger" icon="ti ti-alert-triangle" title={text()} role="alert" />}</Show>
      <div class="cloud-code__dialog-actions">
        <Button type="button" variant="secondary" onClick={() => props.close()}>
          {t.cancel}
        </Button>
        <Button type="submit" variant="primary" loading={busy()} disabled={refused() === draft().origin}>
          {props.state.secrets?.latest ? t.secretCreateAndSubmit : t.secretCreate}
        </Button>
      </div>
    </form>
  );
}

/** Replacing keeps the binding, so the next run uses it at once and no version or approval is involved. */
function ValueDialog(props: { data: CodePageData; state: CodePageReady; secret: CodePageSecret; t: CodePageMessages; close: () => void }) {
  const t = props.t;
  const [value, setValue] = createSignal("");
  const [error, setError] = createSignal<string | undefined>();
  const [failure, setFailure] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const submit = async () => {
    if (busy()) return;
    setFailure(null);
    if (!valueAllowed(value())) return setError(t.secretValueInvalid);
    setError(undefined);
    setBusy(true);
    const sent = value();
    setValue("");
    const written = await writeSecret(props.state.code.id, {
      name: props.secret.name,
      value: sent,
      binding_revision: props.secret.binding_revision,
    });
    if (!written.ok) {
      setBusy(false);
      return setFailure(writeFailure(written.error.status, t));
    }
    props.close();
    documentNavigate(pageUrl(props.data, { secret: props.secret.name, notice: "replaced" }));
  };
  return (
    <form
      class="cloud-code__secret-form"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <p>{t.secretReplaceBody}</p>
      <ValueField t={t} value={value()} onInput={setValue} error={error()} />
      <Show when={failure()}>{(text) => <NoticeCard tone="danger" icon="ti ti-alert-triangle" title={text()} role="alert" />}</Show>
      <div class="cloud-code__dialog-actions">
        <Button type="button" variant="secondary" onClick={() => props.close()}>
          {t.cancel}
        </Button>
        <Button type="submit" variant="primary" loading={busy()}>
          {t.secretSave}
        </Button>
      </div>
    </form>
  );
}

/** Changes the destination in the detail column. Core only accepts a new destination together with a value it receives now. */
function BindingEditor(props: {
  data: CodePageData;
  state: CodePageReady;
  secret: CodePageSecret;
  t: CodePageMessages;
  close: () => void;
}) {
  const t = props.t;
  const [draft, setDraft] = createSignal<BindingDraft>({
    origin: props.secret.origin,
    path: props.secret.pathPrefix,
    header: props.secret.headers.join(", "),
  });
  const [value, setValue] = createSignal("");
  const [errors, setErrors] = createSignal<BindingErrors & { value?: string }>({});
  const [refused, setRefused] = createSignal<string | null>(null);
  const [failure, setFailure] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const parsed = createMemo(() => parseBinding(draft()));
  const old = () => `${props.secret.origin}${props.secret.pathPrefix} · ${props.secret.headers.join(", ")}`;
  const changed = () => {
    const binding = parsed();
    return binding.success ? `${binding.data.origin}${binding.data.pathPrefix} · ${binding.data.headers.join(", ")}` : null;
  };
  const next = () => (props.state.secrets?.latest ? props.state.secrets.latest.number + 1 : null);
  // Cancelling during the address check stops the write.
  let closed = false;
  onCleanup(() => {
    closed = true;
  });
  const submit = async () => {
    if (busy()) return;
    setFailure(null);
    const nextErrors = { ...bindingErrors(draft(), t), value: valueAllowed(value()) ? undefined : t.secretValueInvalid };
    setErrors(nextErrors);
    const binding = parsed();
    if (Object.values(nextErrors).some(Boolean) || !binding.success) return;
    // Everything sent is taken now, together: typing during the check cannot pair a new value with an old address.
    const origin = draft().origin;
    const sent = value();
    setBusy(true);
    const allowed = await checkDestination(props.state.code.id, binding.data);
    if (allowed === null) {
      setBusy(false);
      return setFailure(t.secretCheckFailed);
    }
    if (!allowed) {
      setBusy(false);
      setRefused(origin);
      return;
    }
    if (closed) return;
    setValue("");
    const written = await writeSecret(props.state.code.id, {
      name: props.secret.name,
      value: sent,
      binding_revision: props.secret.binding_revision,
      binding: binding.data,
    });
    if (!written.ok) {
      setBusy(false);
      return setFailure(writeFailure(written.error.status, t));
    }
    await submitAndShow(props.data, props.state, props.secret.name);
  };
  return (
    <form
      class="cloud-code__secret-form"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <BindingFields
        t={t}
        draft={draft()}
        onInput={(field, text) => setDraft({ ...draft(), [field]: text })}
        errors={{ ...errors(), origin: refused() === draft().origin ? t.secretOriginInvalid : errors().origin }}
      />
      <ValueField t={t} value={value()} onInput={setValue} error={errors().value} hint={t.secretValueAgain} />
      <Show when={changed() && changed() !== old()}>
        <ul class="cloud-code__binding-change cloud-code__secret-name">
          <li class="cloud-code__bad">
            <i class="ti ti-minus" aria-hidden="true" /> {old()}
          </li>
          <li class="cloud-code__ok">
            <i class="ti ti-plus" aria-hidden="true" /> {changed()}
          </li>
        </ul>
      </Show>
      <NewBindingNote t={t} state={props.state} />
      <Show when={failure()}>{(text) => <NoticeCard tone="danger" icon="ti ti-alert-triangle" title={text()} role="alert" />}</Show>
      <div class="cloud-code__secret-actions">
        <span class="cloud-code__secret-actions-gap" />
        <Button type="button" variant="secondary" onClick={() => props.close()}>
          {t.cancel}
        </Button>
        <Button type="submit" variant="primary" loading={busy()} disabled={refused() === draft().origin}>
          {next() === null ? t.secretSave : t.secretSubmitVersion({ version: next()! })}
        </Button>
      </div>
    </form>
  );
}

function SecretDetail(props: {
  data: CodePageData;
  state: CodePageReady;
  secret: CodePageSecret;
  t: CodePageMessages;
  date: (iso: string) => string;
}) {
  const t = () => props.t;
  const [editing, setEditing] = createSignal(false);
  const [deleting, setDeleting] = createSignal(false);
  const [submitting, setSubmitting] = createSignal(false);
  const valueText = (): string => {
    const { configured, valueSetBy, valueSetAt } = props.secret;
    if (!configured) return t().secretValueDeleted;
    if (!valueSetAt) return t().secretValueHidden;
    return valueSetBy
      ? t().secretValueBy({ name: valueSetBy.name, date: props.date(valueSetAt) })
      : t().secretValueOn({ date: props.date(valueSetAt) });
  };
  const askValue = () =>
    void prompts.dialog<void>(
      (close) => <ValueDialog data={props.data} state={props.state} secret={props.secret} t={t()} close={() => close()} />,
      {
        title: props.secret.configured
          ? t().secretReplaceTitle({ name: props.secret.name })
          : t().secretSetTitle({ name: props.secret.name }),
        icon: "ti ti-key",
      },
    );
  const remove = async () => {
    const confirmed = await prompts.confirm(t().secretDeleteBody, {
      title: t().secretDeleteTitle({ name: props.secret.name }),
      confirmText: t().secretDeleteConfirm,
      variant: "danger",
    });
    if (!confirmed) return;
    setDeleting(true);
    const result = await invokeCapabilityWithDataSchema(
      {
        appId: "core",
        capabilityId: "code.secret.delete",
        kind: "action",
        target: { type: "core.code", id: props.state.code.id },
        input: { name: props.secret.name, binding_revision: props.secret.binding_revision },
        idempotencyKey: crypto.randomUUID(),
      },
      DeletedSchema,
    );
    setDeleting(false);
    if (!result.ok) return toast.error(t().secretDeleteFailed);
    toast.success(t().secretDeleted);
    refreshCurrentPath();
  };
  const submitAgain = async () => {
    const latest = props.state.secrets?.latest;
    if (!latest) return;
    setSubmitting(true);
    const submitted = await authoring("resubmit", { codeId: props.state.code.id, baseVersionId: latest.id }, SubmittedSchema);
    setSubmitting(false);
    if (!submitted.ok) return toast.error(submitted.status === 409 ? t().secretSubmitConflict : t().secretSubmitFailed);
    documentNavigate(pageUrl(props.data, { secret: props.secret.name, notice: "submitted" }));
  };
  const notice = () => props.state.secrets?.notice ?? null;
  return (
    <section class="cloud-code__run-detail" aria-labelledby="cloud-code-secret-title">
      <div class="cloud-code__run-head">
        <div class="min-w-0">
          <h2 id="cloud-code-secret-title" class="cloud-code__h2 cloud-code__secret-name">
            {props.secret.name}
          </h2>
          <p class="cloud-code__sub">{t().secretOfCode}</p>
        </div>
        <Show when={!props.secret.configured}>
          <StatusBadge tone="warning" label={t().secretValueDeleted} />
        </Show>
      </div>
      <Show when={notice() === "replaced"}>
        <NoticeCard tone="success" icon="ti ti-circle-check" title={t().secretReplacedTitle} detail={t().secretReplacedDetail} />
      </Show>
      <Show when={notice() === "saved"}>
        <NoticeCard tone="success" icon="ti ti-circle-check" title={t().secretSavedTitle} detail={t().secretSavedDetail} />
      </Show>
      <Show when={notice() === "submitted" && props.state.waiting}>
        {(waiting) => (
          <NoticeCard
            tone="success"
            icon="ti ti-circle-check"
            title={t().secretSubmittedTitle({ version: waiting().number })}
            detail={
              waiting().status === "pending"
                ? t().secretSubmittedWaiting({ running: props.state.active?.number ?? null })
                : t().secretSubmittedReady
            }
          />
        )}
      </Show>
      <Show when={notice() === "submit-failed"}>
        <NoticeCard tone="danger" icon="ti ti-alert-triangle" title={t().secretSubmitFailed} role="alert" />
      </Show>
      <Show when={props.secret.unsubmitted && !editing()}>
        <NoticeCard tone="warning" icon="ti ti-user-shield" title={t().secretUnsubmittedTitle} detail={t().secretUnsubmittedDetail}>
          <div class="cloud-code__note-actions">
            <Button type="button" size="sm" variant="secondary" loading={submitting()} onClick={() => void submitAgain()}>
              {t().secretSubmitVersion({ version: (props.state.secrets?.latest?.number ?? 0) + 1 })}
            </Button>
          </div>
        </NoticeCard>
      </Show>
      <p class="text-secondary">{t().secretRules({ placeholder: codeSecretPlaceholder(props.secret.name) })}</p>
      <Show
        when={!editing()}
        fallback={<BindingEditor data={props.data} state={props.state} secret={props.secret} t={t()} close={() => setEditing(false)} />}
      >
        <dl class="cloud-code__facts">
          <dt>{t().secretSentTo}</dt>
          <dd class="cloud-code__secret-name">
            {props.secret.origin}
            {props.secret.pathPrefix}
          </dd>
          <dt>{t().secretHeader}</dt>
          <dd class="cloud-code__secret-name">{props.secret.headers.join(", ")}</dd>
          <dt>{t().secretValue}</dt>
          <dd>{valueText()}</dd>
          <dt>{t().secretUsedIn}</dt>
          <dd>
            {props.secret.usedIn.length > 0
              ? props.secret.usedIn.map((use) => t().secretUsedVersion({ version: use.number, state: use.state })).join(", ")
              : t().secretUsedNowhere}
          </dd>
        </dl>
        <div class="cloud-code__secret-actions">
          <Show when={props.secret.configured}>
            <Button type="button" variant="ghost" class="cloud-code__secret-delete" loading={deleting()} onClick={() => void remove()}>
              <i class="ti ti-trash" aria-hidden="true" />
              {t().secretDelete}
            </Button>
          </Show>
          <span class="cloud-code__secret-actions-gap" />
          <Button type="button" variant="secondary" onClick={() => setEditing(true)}>
            {t().secretChangeBinding}
          </Button>
          <Button type="button" variant="primary" onClick={askValue}>
            {props.secret.configured ? t().secretReplace : t().secretSetValue}
          </Button>
        </div>
      </Show>
    </section>
  );
}

/** The secrets of one Code, for its editors: names and destinations from Core's list, values only ever written. */
export function CodeSecretsTab(props: { data: CodePageData; state: CodePageReady }): JSX.Element {
  const locale = useLocale();
  const t = createMemo(() => codePageMessages.resolve([locale()]).t);
  const date = (iso: string) => dates.formatDate(iso, { ...props.data.dates, locale: locale() });
  const create = () =>
    void prompts.dialog<void>((close) => <CreateDialog data={props.data} state={props.state} t={t()} close={() => close()} />, {
      title: t().secretNew,
      icon: "ti ti-key",
      size: "large",
    });
  const secrets = () => props.state.secrets;
  const selected = () => secrets()?.items.find((item) => item.name === secrets()?.selected) ?? null;
  return (
    <Show
      when={secrets()}
      fallback={
        <div class="cloud-code__body">
          <Placeholder
            state="error"
            variant="panel"
            icon="ti ti-cloud-off"
            title={t().secretLoadFailedTitle}
            description={t().secretLoadFailedDescription}
            onRetry={() => refreshCurrentPath()}
          />
        </div>
      }
    >
      {(list) => (
        <Show
          when={list().items.length > 0}
          fallback={
            <div class="cloud-code__body">
              <Placeholder
                state="empty"
                variant="panel"
                icon="ti ti-key"
                title={t().secretEmptyTitle}
                description={t().secretEmptyDescription}
                action={
                  <Button type="button" variant="primary" onClick={create}>
                    <i class="ti ti-plus" aria-hidden="true" />
                    {t().secretNew}
                  </Button>
                }
              />
            </div>
          }
        >
          <div class="cloud-code__body cloud-code__secrets">
            <section class="cloud-code__run-list" aria-label={t().tabSecrets}>
              <div class="cloud-code__secrets-head">
                <p class="cloud-code__sub">{t().secretsCount({ count: list().items.length })}</p>
                <Button type="button" size="sm" variant="ghost" aria-label={t().secretNew} title={t().secretNew} onClick={create}>
                  <i class="ti ti-plus" aria-hidden="true" />
                </Button>
              </div>
              <ul class="cloud-code__list">
                <For each={list().items}>
                  {(secret) => (
                    <li>
                      <a
                        class="cloud-code__row cloud-code__row--run"
                        href={pageUrl(props.data, { secret: secret.name })}
                        aria-current={secret.name === list().selected ? "true" : undefined}
                      >
                        <span class="cloud-code__cell">
                          <span class="cloud-code__title cloud-code__secret-name">{secret.name}</span>
                          <span class="cloud-code__sub cloud-code__secret-name">
                            {secret.origin}
                            {secret.pathPrefix} · {secret.headers.join(", ")}
                          </span>
                        </span>
                        <Show when={!secret.configured}>
                          <StatusBadge tone="warning" label={t().secretValueDeleted} variant="dot" />
                        </Show>
                      </a>
                    </li>
                  )}
                </For>
              </ul>
              <Show when={list().more}>
                <p class="cloud-code__quiet">{t().secretMore}</p>
              </Show>
            </section>
            <Show when={selected()} keyed>
              {(secret) => <SecretDetail data={props.data} state={props.state} secret={secret} t={t()} date={date} />}
            </Show>
          </div>
        </Show>
      )}
    </Show>
  );
}
