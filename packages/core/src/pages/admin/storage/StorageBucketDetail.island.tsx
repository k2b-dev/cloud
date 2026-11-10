import type { AdminStorageBucket, StorageBucketAccess, StorageBucketUsage } from "@k2b/cloud/contracts/storage-buckets";
import { navigateTo } from "@k2b/ssr/nav";
import {
  Button,
  ChoiceList,
  CopyButton,
  Format,
  InlineGuidance,
  NoticeCard,
  prompts,
  SettingsField,
  SettingsSection,
  TextInput,
  toast,
  useLocale,
} from "@k2b/ui";
import { createEffect, createSignal, type JSX, onCleanup, Show } from "solid-js";
import { readBucket, StorageAdminError, storageAdminApi } from "./client";
import { setStorageDetailControls } from "./detail-controls";
import { storageAreaMessages } from "./messages";
import { StorageCheckNotice, StorageUsage } from "./parts";
import { storageBucketHref } from "./presentation";

type Draft = {
  name: string;
  access: StorageBucketAccess;
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
};

const draftOf = (bucket: AdminStorageBucket | null): Draft => ({
  name: bucket?.name ?? "",
  access: bucket?.access ?? "inherit",
  endpoint: bucket?.access === "own" ? (bucket.endpoint ?? "") : "",
  region: bucket?.access === "own" ? (bucket.region ?? "") : "",
  bucket: bucket?.bucket ?? "",
  accessKeyId: "",
  secretAccessKey: "",
});

const Field = (props: {
  label: string;
  description: string;
  error?: string;
  width?: "short" | "medium" | "long";
  children: (describedBy: () => string) => JSX.Element;
}) => (
  <SettingsField label={props.label} description={props.description} error={() => props.error} width={props.width}>
    {(control) => props.children(control.describedBy)}
  </SettingsField>
);

/**
 * One further bucket: add it, change it, test it, remove it and restore it. The default bucket has its own view,
 * because it saves through the storage settings.
 */
export default function StorageBucketDetail(props: { bucket: AdminStorageBucket | null }) {
  const locale = useLocale();
  const t = () => storageAreaMessages.resolve([locale()]).t;
  const [base, setBase] = createSignal<AdminStorageBucket | null>(props.bucket);
  const [draft, setDraft] = createSignal<Draft>(draftOf(props.bucket));
  const [saving, setSaving] = createSignal(false);
  const [testing, setTesting] = createSignal(false);
  const [restoring, setRestoring] = createSignal(false);
  const [error, setError] = createSignal("");
  const [fieldErrors, setFieldErrors] = createSignal<Partial<Record<keyof Draft, string>>>({});
  const [conflict, setConflict] = createSignal<AdminStorageBucket | null>(null);
  const [usage, setUsage] = createSignal<StorageBucketUsage | null | undefined>(undefined);

  const isNew = () => base() === null;
  const removed = () => Boolean(base()?.removedAt);
  const hasKeys = () => base()?.access === "own" && base()?.hasCredentials === true;
  const update = (patch: Partial<Draft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    const cleared = { ...fieldErrors() };
    for (const key of Object.keys(patch) as (keyof Draft)[]) delete cleared[key];
    setFieldErrors(cleared);
  };
  const dirty = () => {
    const current = draft();
    const stored = draftOf(base());
    return (
      JSON.stringify({ ...current, accessKeyId: "", secretAccessKey: "" }) !== JSON.stringify(stored) ||
      !!current.accessKeyId ||
      !!current.secretAccessKey
    );
  };
  // Keys are needed to add an own bucket, to switch to own keys, and to restore an own bucket.
  const keysNeeded = () => draft().access === "own" && !hasKeys();

  const missing = (): Partial<Record<keyof Draft, string>> => {
    const current = draft();
    const required: (keyof Draft)[] = ["name", "bucket"];
    if (current.access === "own") required.push("endpoint", "region");
    if (keysNeeded()) required.push("accessKeyId", "secretAccessKey");
    return Object.fromEntries(required.filter((key) => !current[key].trim()).map((key) => [key, t().required]));
  };

  const fail = (failure: unknown, fallback: string) => {
    if (failure instanceof StorageAdminError && failure.code === "storage_bucket_conflict" && failure.current) {
      setConflict(failure.current);
      return;
    }
    if (failure instanceof StorageAdminError && failure.code === "storage_bucket_name_taken") {
      setFieldErrors({ ...fieldErrors(), name: t().nameTaken });
      return;
    }
    setError(failure instanceof Error && failure.message ? failure.message : fallback);
  };

  const announce = (bucket: AdminStorageBucket, created: boolean) => {
    const name = bucket.name;
    if (bucket.check.state === "ok") toast.success(created ? t().createdOk({ name }) : t().saved);
    else if (created) toast(t().createdFailed({ name }), { variant: "warning" });
    else toast.success(t().saved);
  };

  const save = async (revision = base()?.revision ?? null) => {
    const errors = missing();
    if (Object.keys(errors).length) {
      setFieldErrors(errors);
      return;
    }
    setSaving(true);
    setError("");
    const current = draft();
    try {
      const keys = {
        ...(current.accessKeyId.trim() ? { accessKeyId: current.accessKeyId.trim() } : {}),
        ...(current.secretAccessKey ? { secretAccessKey: current.secretAccessKey } : {}),
      };
      const stored = base();
      const bucket =
        stored === null
          ? await readBucket(
              await storageAdminApi.buckets.$post({
                json:
                  current.access === "inherit"
                    ? { access: "inherit", name: current.name, bucket: current.bucket }
                    : {
                        access: "own",
                        name: current.name,
                        endpoint: current.endpoint,
                        region: current.region,
                        bucket: current.bucket,
                        accessKeyId: current.accessKeyId.trim(),
                        secretAccessKey: current.secretAccessKey,
                      },
              }),
              t().saveFailed,
            )
          : await readBucket(
              await storageAdminApi.buckets[":id"].$put({
                param: { id: stored.id },
                json:
                  current.access === "inherit"
                    ? { access: "inherit", revision: revision ?? 1, name: current.name, bucket: current.bucket }
                    : {
                        access: "own",
                        revision: revision ?? 1,
                        name: current.name,
                        endpoint: current.endpoint,
                        region: current.region,
                        bucket: current.bucket,
                        ...keys,
                      },
              }),
              t().saveFailed,
            );
      announce(bucket, stored === null);
      navigateTo(storageBucketHref(bucket.id));
    } catch (failure) {
      fail(failure, t().saveFailed);
      setSaving(false);
    }
  };

  const test = async () => {
    const stored = base();
    if (!stored) return;
    setTesting(true);
    setError("");
    try {
      const bucket = await readBucket(await storageAdminApi.buckets[":id"].test.$post({ param: { id: stored.id } }), t().testFailed);
      if (bucket.check.state === "ok") toast.success(t().testOk);
      navigateTo(storageBucketHref(bucket.id));
    } catch (failure) {
      fail(failure, t().testFailed);
      setTesting(false);
    }
  };

  const remove = async () => {
    const stored = base();
    if (!stored) return;
    const name = stored.name;
    const known = usage();
    const confirmed = await prompts.confirm(
      <div class="grid gap-2 text-sm">
        <p>{t().removeLead}</p>
        <ul class="ms-5 list-disc space-y-1">
          <li data-storage-remove-usage>
            {known === undefined || known === null
              ? t().removeUsageUnknown
              : known.packages.length
                ? t().removeUsage({ list: known.packages.join(", ") + (known.truncated ? `, ${t().usageMore}` : "") })
                : t().removeUsageNone}
          </li>
          <li>{t().removeLimits}</li>
          <li>{t().removeReserved}</li>
        </ul>
      </div>,
      { title: t().removeTitle({ name }), confirmText: t().remove, variant: "danger" },
    );
    if (!confirmed) return;
    setSaving(true);
    try {
      await readBucket(await storageAdminApi.buckets[":id"].$delete({ param: { id: stored.id } }), t().saveFailed);
      toast.success(t().removedOk({ name }));
      navigateTo(storageBucketHref(stored.id));
    } catch (failure) {
      fail(failure, t().saveFailed);
      setSaving(false);
    }
  };

  const restore = async () => {
    const stored = base();
    if (!stored) return;
    if (keysNeeded()) {
      const errors = Object.fromEntries(
        (["accessKeyId", "secretAccessKey"] as const).filter((key) => !draft()[key].trim()).map((key) => [key, t().required]),
      );
      if (Object.keys(errors).length) {
        setFieldErrors(errors);
        return;
      }
    }
    setRestoring(true);
    setError("");
    try {
      const bucket = await readBucket(
        await storageAdminApi.buckets[":id"].restore.$post({
          param: { id: stored.id },
          json: stored.access === "own" ? { accessKeyId: draft().accessKeyId.trim(), secretAccessKey: draft().secretAccessKey } : {},
        }),
        t().saveFailed,
      );
      toast.success(t().restoredOk({ name: bucket.name }));
      navigateTo(storageBucketHref(bucket.id));
    } catch (failure) {
      fail(failure, t().saveFailed);
      setRestoring(false);
    }
  };

  createEffect(() =>
    setStorageDetailControls(
      removed()
        ? { restore: { busy: restoring(), run: () => void restore() } }
        : {
            ...(isNew()
              ? {}
              : {
                  test: { busy: testing(), disabled: dirty(), run: () => void test() },
                  remove: { disabled: saving(), run: () => void remove() },
                }),
            save: {
              label: isNew() ? t().create : t().save,
              // A new bucket can always be added; missing fields then say so.
              dirty: (isNew() || dirty()) && !conflict(),
              saving: saving(),
              run: () => void save(),
            },
          },
    ),
  );
  onCleanup(() => setStorageDetailControls(null));

  const keyFields = () => (
    <>
      <Field
        label={t().accessKeyId}
        description={hasKeys() && !removed() ? t().keyStored : t().keyNeeded}
        error={fieldErrors().accessKeyId}
      >
        {(describedBy) => (
          <TextInput
            aria-label={t().accessKeyId}
            aria-describedby={describedBy()}
            autocomplete="off"
            monospace
            value={() => draft().accessKeyId}
            onValueChange={(accessKeyId) => update({ accessKeyId })}
            placeholder={hasKeys() && !removed() ? t().storedPlaceholder : "GK…"}
          />
        )}
      </Field>
      <Field
        label={t().secretAccessKey}
        description={hasKeys() && !removed() ? t().keyStored : t().keyNeeded}
        error={fieldErrors().secretAccessKey}
      >
        {(describedBy) => (
          <TextInput
            aria-label={t().secretAccessKey}
            aria-describedby={describedBy()}
            autocomplete="off"
            password
            value={() => draft().secretAccessKey}
            onValueChange={(secretAccessKey) => update({ secretAccessKey })}
            placeholder={hasKeys() && !removed() ? t().storedPlaceholder : ""}
          />
        )}
      </Field>
    </>
  );

  return (
    <div class="flex flex-col gap-4 pb-8" data-storage-detail={isNew() ? "new" : removed() ? "removed" : "edit"}>
      <Show when={base()}>{(bucket) => <Show when={!removed()}>{<StorageCheckNotice t={t()} bucket={bucket()} />}</Show>}</Show>
      <Show when={removed() ? base() : null}>
        {(bucket) => (
          <NoticeCard tone="neutral" data-storage-removed>
            <b>
              {t().removedOn} <Format.Date value={bucket().removedAt ?? undefined} />.
            </b>{" "}
            {t().removedDetail}
          </NoticeCard>
        )}
      </Show>
      <Show when={conflict()}>
        {(current) => (
          <NoticeCard
            tone="warning"
            role="alert"
            data-storage-conflict
            title={current().updatedBy ? t().conflictTitle({ name: current().updatedBy?.name ?? "" }) : t().conflictTitleUnknown}
            detail={t().conflictDetail}
          >
            <span class="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => {
                  setBase(current());
                  setDraft(draftOf(current()));
                  setConflict(null);
                }}
              >
                {t().takeTheirs}
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={() => {
                  setBase(current());
                  setConflict(null);
                  void save(current().revision);
                }}
              >
                {t().keepMine}
              </Button>
            </span>
          </NoticeCard>
        )}
      </Show>
      <Show when={error()}>
        <NoticeCard tone="danger" role="alert" title={t().saveFailed} detail={error()} />
      </Show>

      <Show
        when={!removed()}
        fallback={
          <SettingsSection title={t().lastTarget} subtitle={base()?.access === "own" ? t().restoreKeys : t().restoreHelp}>
            <dl class="grid grid-cols-[minmax(8rem,auto)_1fr] gap-x-6 gap-y-2 text-sm">
              <dt class="text-(--k2b-text-muted)">{t().id}</dt>
              <dd class="font-mono break-all">{base()?.id}</dd>
              <dt class="text-(--k2b-text-muted)">{t().endpoint}</dt>
              <dd class="break-all">{base()?.access === "inherit" ? t().likeDefault : base()?.endpoint}</dd>
              <dt class="text-(--k2b-text-muted)">{t().bucket}</dt>
              <dd class="font-mono break-all">{base()?.bucket}</dd>
            </dl>
            <Show when={base()?.access === "own"}>
              <fieldset class="contents" disabled={restoring()}>
                {keyFields()}
              </fieldset>
            </Show>
          </SettingsSection>
        }
      >
        <fieldset class="contents" disabled={saving()}>
          <SettingsSection title={t().identity} subtitle={t().identityHelp}>
            <Field label={t().name} description={t().nameHelp} error={fieldErrors().name} width="medium">
              {(describedBy) => (
                <TextInput
                  aria-label={t().name}
                  aria-describedby={describedBy()}
                  value={() => draft().name}
                  onValueChange={(name) => update({ name })}
                  placeholder={t().namePlaceholder}
                  maxLength={60}
                />
              )}
            </Field>
            <Field label={t().id} description={isNew() ? t().idAfterCreate : t().idHelp}>
              {() => (
                <Show when={base()} fallback={<span class="text-sm text-(--k2b-text-muted)">—</span>}>
                  {(bucket) => (
                    <span class="flex min-h-8 items-center gap-2">
                      <code class="font-mono text-sm break-all" data-storage-bucket-id>
                        {bucket().id}
                      </code>
                      <CopyButton value={bucket().id} iconOnly size="xs" variant="ghost" label={t().copyId} copiedLabel={t().copied} />
                    </span>
                  )}
                </Show>
              )}
            </Field>
          </SettingsSection>

          <SettingsSection title={t().connection} subtitle={isNew() ? t().afterCreate : undefined}>
            <Field label={t().access} description={t().accessHelp}>
              {(describedBy) => (
                <ChoiceList<StorageBucketAccess>
                  aria-label={t().access}
                  aria-describedby={describedBy()}
                  value={() => draft().access}
                  onValueChange={(access) => update({ access })}
                  options={[
                    { value: "inherit", label: t().inherit, description: t().inheritHelp },
                    { value: "own", label: t().own, description: t().ownHelp },
                  ]}
                />
              )}
            </Field>
            <Show when={draft().access === "own"}>
              <Field label={t().endpoint} description={t().endpointHelp} error={fieldErrors().endpoint}>
                {(describedBy) => (
                  <TextInput
                    aria-label={t().endpoint}
                    aria-describedby={describedBy()}
                    type="url"
                    monospace
                    value={() => draft().endpoint}
                    onValueChange={(endpoint) => update({ endpoint })}
                    placeholder="https://s3.example.org"
                  />
                )}
              </Field>
              <Field label={t().region} description={t().regionHelp} error={fieldErrors().region} width="short">
                {(describedBy) => (
                  <TextInput
                    aria-label={t().region}
                    aria-describedby={describedBy()}
                    monospace
                    value={() => draft().region}
                    onValueChange={(region) => update({ region })}
                    placeholder="garage"
                  />
                )}
              </Field>
            </Show>
            <Field label={t().bucket} description={isNew() ? t().bucketHelp : t().targetChange} error={fieldErrors().bucket}>
              {(describedBy) => (
                <TextInput
                  aria-label={t().bucket}
                  aria-describedby={describedBy()}
                  monospace
                  value={() => draft().bucket}
                  onValueChange={(bucket) => update({ bucket })}
                  placeholder="cloud-archive"
                />
              )}
            </Field>
            <Show when={draft().access === "own"}>{keyFields()}</Show>
          </SettingsSection>
        </fieldset>

        <Show when={base()}>{(bucket) => <StorageUsage t={t()} id={bucket().id} onLoaded={setUsage} />}</Show>
        <Show when={!isNew()}>
          <InlineGuidance tone="neutral" icon="ti ti-database-export">
            {t().backup}
          </InlineGuidance>
        </Show>
      </Show>
    </div>
  );
}
