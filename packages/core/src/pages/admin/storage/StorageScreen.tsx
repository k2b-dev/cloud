import type { AdminStorageBucket, StorageBucketAccess, StorageBucketUsage } from "@k2b/cloud/contracts/storage-buckets";
import { StorageBucketUsageSchema } from "@k2b/cloud/contracts/storage-buckets";
import { AdminWorkspace } from "@k2b/cloud/ssr/islands";
import { navigateTo } from "@k2b/ssr/nav";
import { useLocale } from "@k2b/ui";
import {
  Bar,
  Button,
  Chip,
  Choice,
  Dialog,
  Empty,
  Facts,
  Failed,
  Field,
  Inline,
  Input,
  Loading,
  type NavProps,
  Notice,
  Pane,
  Section,
  StatusRow,
  Table,
  Text,
  useToast,
} from "@k2b/ui/v2";
import { createSignal, For, type JSX, Match, Show, Switch } from "solid-js";
import RegistryForm from "../_area/RegistryForm";
import type { SettingFieldDef } from "../settings/_components/setting-field";
import { readBucket, readStorageAdmin, StorageAdminError, storageAdminApi } from "./client";
import { type StorageAreaMessages, storageAreaMessages } from "./messages";
import {
  STORAGE_AREA_HREF,
  type StorageBucketState,
  storageBucketHref,
  storageBucketLine,
  storageBucketName,
  storageBucketState,
  storageStateLabel,
  storageStepLabel,
} from "./presentation";

/** What the address opens: nothing chosen (the default bucket shows), a bucket, the form for a new one, or an unknown ID. */
export type StorageSelection = { kind: "none" } | { kind: "new" } | { kind: "bucket"; bucket: AdminStorageBucket } | { kind: "unknown" };

const CONNECTION_KEYS = ["storage.endpoint", "storage.region", "storage.bucket", "storage.access_key_id", "storage.secret_access_key"];
const TONE: Record<StorageBucketState, "ok" | "bad" | undefined> = { ok: "ok", failed: "bad", untested: undefined, removed: undefined };

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

/** A bucket's state as a chip: a tone for ok and failed, a plain word for untested and removed. */
const StateChip = (props: { t: StorageAreaMessages; bucket: AdminStorageBucket }) => {
  const state = () => storageBucketState(props.bucket);
  return (
    <Show when={TONE[state()]} fallback={<Chip>{storageStateLabel(props.t, state())}</Chip>}>
      {(tone) => <Chip status={tone()}>{storageStateLabel(props.t, state())}</Chip>}
    </Show>
  );
};

/** The last connection test of a bucket; a failed one names the step. */
const CheckNotice = (props: { t: StorageAreaMessages; bucket: AdminStorageBucket; time: (iso: string) => string }) => (
  <Switch>
    <Match when={props.bucket.check.state === "failed"}>
      <Notice tone="bad" title={props.t.failedNotice({ step: storageStepLabel(props.t, props.bucket.check.step) })}>
        {props.t.failedDetail}
      </Notice>
    </Match>
    <Match when={props.bucket.check.state === "untested"}>
      <Notice tone="note" title={props.t.untestedNotice}>
        {props.t.untestedDetail}
      </Notice>
    </Match>
    <Match when={props.bucket.check.state === "ok"}>
      <Text type="meta" tone="ok">
        {`${props.t.okTested} ${props.bucket.check.checkedAt ? props.time(props.bucket.check.checkedAt) : ""} ${props.t.okDetail}`}
      </Text>
    </Match>
  </Switch>
);

/** Which app areas have data in a bucket. It is read from the bucket on request, so the page never waits for it. */
const Usage = (props: { t: StorageAreaMessages; id: string; onLoaded?: (usage: StorageBucketUsage | null) => void }) => {
  const [state, setState] = createSignal<"idle" | "loading" | "failed" | StorageBucketUsage>("idle");
  const load = async () => {
    setState("loading");
    try {
      const usage = await readStorageAdmin(
        await storageAdminApi.buckets[":id"].usage.$get({ param: { id: props.id } }),
        StorageBucketUsageSchema,
        "usage",
      );
      setState(usage);
      props.onLoaded?.(usage);
    } catch {
      setState("failed");
      props.onLoaded?.(null);
    }
  };
  const ready = () => {
    const value = state();
    return typeof value === "object" ? value : undefined;
  };
  return (
    <Section
      icon="folders"
      title={props.t.usage}
      summary={props.t.usageHelp}
      actions={state() === "idle" ? [{ label: props.t.usageShow, icon: "eye", onClick: () => void load() }] : undefined}
    >
      <Switch>
        <Match when={state() === "loading"}>
          <Loading rows={1} />
        </Match>
        <Match when={state() === "failed"}>
          <Failed text={props.t.usageFailed} onRetry={() => void load()} />
        </Match>
        <Match when={ready()}>
          {(usage) => (
            <Show when={usage().packages.length > 0} fallback={<Text muted>{props.t.usageNone}</Text>}>
              <Inline>
                <For each={usage().packages}>{(name) => <Chip tag>{name}</Chip>}</For>
                <Show when={usage().truncated}>
                  <Text type="meta" muted>
                    {props.t.usageMore}
                  </Text>
                </Show>
              </Inline>
            </Show>
          )}
        </Match>
      </Switch>
      <Text type="meta" muted>
        {props.t.backup}
      </Text>
    </Section>
  );
};

/** A further bucket: add it, change it, test it, remove it after one question, and restore it. */
const BucketForm = (props: { t: StorageAreaMessages; bucket: AdminStorageBucket | null; time: (iso: string) => string }) => {
  const t = () => props.t;
  const toast = useToast();
  const [base, setBase] = createSignal<AdminStorageBucket | null>(props.bucket);
  const [draft, setDraft] = createSignal<Draft>(draftOf(props.bucket));
  const [saving, setSaving] = createSignal(false);
  const [testing, setTesting] = createSignal(false);
  const [error, setError] = createSignal("");
  const [fieldErrors, setFieldErrors] = createSignal<Partial<Record<keyof Draft, string>>>({});
  const [conflict, setConflict] = createSignal<AdminStorageBucket | null>(null);
  const [usage, setUsage] = createSignal<StorageBucketUsage | null | undefined>(undefined);
  const isNew = () => base() === null;
  const removed = () => Boolean(base()?.removedAt);
  const hasKeys = () => base()?.access === "own" && base()?.hasCredentials === true;
  const busy = () => saving() || testing();
  const update = (patch: Partial<Draft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    const cleared = { ...fieldErrors() };
    for (const key of Object.keys(patch) as (keyof Draft)[]) delete cleared[key];
    setFieldErrors(cleared);
  };
  const dirty = () => {
    const current = draft();
    return (
      JSON.stringify({ ...current, accessKeyId: "", secretAccessKey: "" }) !== JSON.stringify(draftOf(base())) ||
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
    if (failure instanceof StorageAdminError && failure.code === "storage_bucket_conflict" && failure.current)
      return void setConflict(failure.current);
    if (failure instanceof StorageAdminError && failure.code === "storage_bucket_name_taken") {
      // A removed bucket shows no name field; restoring says what to rename first.
      if (removed()) setError(t().nameTakenRestore);
      else setFieldErrors({ ...fieldErrors(), name: t().nameTaken });
      return;
    }
    setError(failure instanceof Error && failure.message ? failure.message : fallback);
  };
  const save = async (revision = base()?.revision ?? null) => {
    const errors = missing();
    if (Object.keys(errors).length) return void setFieldErrors(errors);
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
      if (bucket.check.state === "ok") toast(stored === null ? t().createdOk({ name: bucket.name }) : t().saved, { status: "ok" });
      else toast(stored === null ? t().createdFailed({ name: bucket.name }) : t().saved, { status: stored === null ? "bad" : "ok" });
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
      if (bucket.check.state === "ok") toast(t().testOk, { status: "ok" });
      navigateTo(storageBucketHref(bucket.id));
    } catch (failure) {
      fail(failure, t().testFailed);
      setTesting(false);
    }
  };
  const remove = async () => {
    const stored = base();
    if (!stored) return;
    const known = usage();
    const where =
      known === undefined || known === null
        ? t().removeUsageUnknown
        : known.packages.length
          ? t().removeUsage({ list: known.packages.join(", ") + (known.truncated ? `, ${t().usageMore}` : "") })
          : t().removeUsageNone;
    const confirmed = await Dialog.confirm({
      title: t().removeTitle({ name: stored.name }),
      description: [t().removeLead, where, t().removeLimits, t().removeReserved].join(" "),
      confirm: t().remove,
    });
    if (!confirmed) return;
    setSaving(true);
    try {
      await readBucket(await storageAdminApi.buckets[":id"].$delete({ param: { id: stored.id } }), t().saveFailed);
      toast(t().removedOk({ name: stored.name }), { status: "ok" });
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
      if (Object.keys(errors).length) return void setFieldErrors(errors);
    }
    setSaving(true);
    setError("");
    try {
      const bucket = await readBucket(
        await storageAdminApi.buckets[":id"].restore.$post({
          param: { id: stored.id },
          json: stored.access === "own" ? { accessKeyId: draft().accessKeyId.trim(), secretAccessKey: draft().secretAccessKey } : {},
        }),
        t().saveFailed,
      );
      toast(t().restoredOk({ name: bucket.name }), { status: "ok" });
      navigateTo(storageBucketHref(bucket.id));
    } catch (failure) {
      fail(failure, t().saveFailed);
      setSaving(false);
    }
  };
  const keyFields = () => (
    <>
      <Field
        name="accessKeyId"
        label={t().accessKeyId}
        hint={hasKeys() && !removed() ? t().keyStored : t().keyNeeded}
        error={fieldErrors().accessKeyId}
      >
        <Input
          value={draft().accessKeyId}
          placeholder={hasKeys() && !removed() ? t().storedPlaceholder : "GK…"}
          disabled={busy()}
          onInput={(accessKeyId) => update({ accessKeyId })}
        />
      </Field>
      <Field
        name="secretAccessKey"
        label={t().secretAccessKey}
        hint={hasKeys() && !removed() ? t().keyStored : t().keyNeeded}
        error={fieldErrors().secretAccessKey}
      >
        <Input
          type="password"
          value={draft().secretAccessKey}
          placeholder={hasKeys() && !removed() ? t().storedPlaceholder : ""}
          disabled={busy()}
          onInput={(secretAccessKey) => update({ secretAccessKey })}
        />
      </Field>
    </>
  );
  return (
    <>
      <Show when={base() && !removed() ? base() : undefined}>
        {(bucket) => <CheckNotice t={t()} bucket={bucket()} time={props.time} />}
      </Show>
      <Show when={removed() ? base() : undefined}>
        {(bucket) => (
          <Notice tone="note" title={`${t().removedOn} ${bucket().removedAt ? props.time(bucket().removedAt!) : ""}.`}>
            {t().removedDetail}
          </Notice>
        )}
      </Show>
      <Show when={conflict()}>
        {(current) => (
          <Notice
            tone="warn"
            title={current().updatedBy ? t().conflictTitle({ name: current().updatedBy?.name ?? "" }) : t().conflictTitleUnknown}
            actions={[
              {
                label: t().takeTheirs,
                onClick: () => {
                  setBase(current());
                  setDraft(draftOf(current()));
                  setConflict(null);
                },
              },
              {
                label: t().keepMine,
                onClick: () => {
                  setBase(current());
                  setConflict(null);
                  void save(current().revision);
                },
              },
            ]}
          >
            {t().conflictDetail}
          </Notice>
        )}
      </Show>
      <Show when={error()}>
        <Notice tone="bad" title={t().saveFailed}>
          {error()}
        </Notice>
      </Show>
      <Show
        when={!removed()}
        fallback={
          <Section icon="history" title={t().lastTarget} summary={base()?.access === "own" ? t().restoreKeys : t().restoreHelp}>
            <Facts
              items={[
                { label: t().id, value: base()?.id ?? "", mono: true, copy: base()?.id },
                { label: t().endpoint, value: base()?.access === "inherit" ? t().likeDefault : (base()?.endpoint ?? "") },
                { label: t().bucket, value: base()?.bucket ?? "", mono: true },
              ]}
            />
            <Show when={base()?.access === "own"}>{keyFields()}</Show>
            <Bar
              end={
                <Button variant="primary" busy={saving()} onClick={() => void restore()}>
                  {t().restore}
                </Button>
              }
            />
          </Section>
        }
      >
        <Section icon="id" title={t().identity} summary={t().identityHelp}>
          <Field name="name" label={t().name} hint={t().nameHelp} error={fieldErrors().name} required>
            <Input value={draft().name} placeholder={t().namePlaceholder} disabled={busy()} onInput={(name) => update({ name })} />
          </Field>
          <Show
            when={base()}
            fallback={
              <Text type="meta" muted>
                {t().idAfterCreate}
              </Text>
            }
          >
            {(bucket) => <Facts items={[{ label: t().id, value: bucket().id, mono: true, copy: bucket().id }]} />}
          </Show>
        </Section>
        <Section icon="plug-connected" title={t().connection} summary={isNew() ? t().afterCreate : undefined}>
          <Field name="access" label={t().access} hint={draft().access === "inherit" ? t().inheritHelp : t().ownHelp}>
            <Choice
              name="access"
              value={draft().access}
              disabled={busy()}
              options={[
                { value: "inherit", label: t().inherit },
                { value: "own", label: t().own },
              ]}
              onChange={(value) => update({ access: value === "own" ? "own" : "inherit" })}
            />
          </Field>
          <Show when={draft().access === "own"}>
            <Field name="endpoint" label={t().endpoint} hint={t().endpointHelp} error={fieldErrors().endpoint}>
              <Input
                type="url"
                value={draft().endpoint}
                placeholder="https://s3.example.org"
                disabled={busy()}
                onInput={(endpoint) => update({ endpoint })}
              />
            </Field>
            <Field name="region" label={t().region} hint={t().regionHelp} error={fieldErrors().region}>
              <Input value={draft().region} placeholder="garage" disabled={busy()} onInput={(region) => update({ region })} />
            </Field>
          </Show>
          <Field name="bucket" label={t().bucket} hint={isNew() ? t().bucketHelp : t().targetChange} error={fieldErrors().bucket}>
            <Input value={draft().bucket} placeholder="cloud-archive" disabled={busy()} onInput={(bucket) => update({ bucket })} />
          </Field>
          <Show when={draft().access === "own"}>{keyFields()}</Show>
          <Bar
            start={
              <Show when={!isNew()}>
                <Button variant="text" icon="trash" disabled={busy()} onClick={() => void remove()}>
                  {t().remove}
                </Button>
              </Show>
            }
            end={
              <>
                <Show when={!isNew()}>
                  <Button icon="plug-connected" busy={testing()} disabled={dirty() || saving()} onClick={() => void test()}>
                    {base()?.check.state === "failed" ? t().testAgain : t().test}
                  </Button>
                </Show>
                <Button
                  variant="primary"
                  busy={saving()}
                  disabled={(!isNew() && !dirty()) || !!conflict() || testing()}
                  onClick={() => void save()}
                >
                  {isNew() ? t().create : t().save}
                </Button>
              </>
            }
          />
        </Section>
        <Show when={base()}>{(bucket) => <Usage t={t()} id={bucket().id} onLoaded={setUsage} />}</Show>
      </Show>
    </>
  );
};

/** The default bucket: its last test, its ID, its connection as storage settings, and its usage. */
const DefaultDetail = (props: {
  t: StorageAreaMessages;
  bucket: AdminStorageBucket;
  entries: SettingFieldDef[];
  time: (iso: string) => string;
}) => {
  const toast = useToast();
  const [bucket, setBucket] = createSignal(props.bucket);
  const [testing, setTesting] = createSignal(false);
  const [error, setError] = createSignal("");
  // Testing updates the notice in place, so an unsaved draft in the form stays as it is.
  const test = async () => {
    setTesting(true);
    setError("");
    try {
      const tested = await readBucket(await storageAdminApi.buckets[":id"].test.$post({ param: { id: bucket().id } }), props.t.testFailed);
      setBucket(tested);
      if (tested.check.state === "ok") toast(props.t.testOk, { status: "ok" });
    } catch (failure) {
      setError(failure instanceof Error && failure.message ? failure.message : props.t.testFailed);
    } finally {
      setTesting(false);
    }
  };
  return (
    <>
      <CheckNotice t={props.t} bucket={bucket()} time={props.time} />
      <Show when={error()}>
        <Notice tone="bad" title={props.t.testFailed}>
          {error()}
        </Notice>
      </Show>
      <Section
        icon="id"
        title={props.t.identity}
        summary={props.t.defaultIdentityHelp}
        actions={[
          {
            label: bucket().check.state === "failed" ? props.t.testAgain : props.t.test,
            icon: "plug-connected",
            onClick: () => void test(),
            disabled: testing(),
          },
        ]}
      >
        <Facts items={[{ label: props.t.id, value: bucket().id, mono: true, copy: bucket().id }]} />
      </Section>
      <RegistryForm
        groups={["storage", "previews"]}
        sections={[
          { title: props.t.connection, keys: CONNECTION_KEYS },
          { title: props.t.limits, description: props.t.maxSize, keys: ["storage.max_object_bytes", "previews.max_bytes"] },
        ]}
        entries={props.entries}
        reloadAfter={CONNECTION_KEYS}
      />
      <Usage t={props.t} id={bucket().id} />
    </>
  );
};

export type StorageScreenProps = {
  nav: NavProps;
  /** `null` when the list could not be read. */
  items: AdminStorageBucket[] | null;
  selection: StorageSelection;
  /** The storage settings that configure the default bucket. */
  defaultEntries: SettingFieldDef[];
  documentationHref?: string;
  /** The reader's time zone, so the server and the browser word times alike. */
  timeZone: string;
};

/**
 * Storage on v2: the default bucket and the further buckets apps can use as a list, and the open bucket beside it.
 * What is open lives in the address (`?bucket=`); with nothing chosen the default bucket shows.
 */
export default function StorageScreen(props: StorageScreenProps) {
  const locale = useLocale();
  const t = () => storageAreaMessages.resolve([locale()]).t;
  const time = (iso: string) =>
    new Intl.DateTimeFormat(locale(), { dateStyle: "medium", timeStyle: "short", timeZone: props.timeZone }).format(new Date(iso));
  const items = () => props.items ?? [];
  // What is open lives in the address: with nothing chosen the list stands alone, also on the phone.
  const open = (): AdminStorageBucket | null => (props.selection.kind === "bucket" ? props.selection.bucket : null);
  const currentKey = () => (props.selection.kind === "new" ? undefined : open()?.id);
  const detailTitle = () =>
    props.selection.kind === "new"
      ? t().newBucket
      : props.selection.kind === "unknown"
        ? t().unknownTitle
        : open()
          ? storageBucketName(t(), open()!)
          : t().area;
  const add = { label: t().add, icon: "plus", href: storageBucketHref("new") };
  const detail = (): JSX.Element => {
    if (props.selection.kind === "unknown")
      return <Empty icon="database-off" text={t().unknownDetail} action={{ label: t().area, href: STORAGE_AREA_HREF }} />;
    if (props.selection.kind === "new") return <BucketForm t={t()} bucket={null} time={time} />;
    const bucket = open();
    if (!bucket) return undefined;
    if (!bucket.isDefault) return <BucketForm t={t()} bucket={bucket} time={time} />;
    return <DefaultDetail t={t()} bucket={bucket} entries={props.defaultEntries} time={time} />;
  };
  return (
    <AdminWorkspace
      nav={props.nav}
      detail={480}
      detailEmpty={{ icon: "database", text: t().noneOpen }}
      primary={add}
      head={
        <Bar
          start={<Text type="body">{t().area}</Text>}
          end={
            <>
              <Show when={props.documentationHref}>
                {(href) => (
                  <Button variant="text" icon="book" href={href()}>
                    {t().documentation}
                  </Button>
                )}
              </Show>
              <Button variant="primary" icon="plus" href={add.href}>
                {t().add}
              </Button>
            </>
          }
        />
      }
    >
      <Pane.Split>
        <Pane
          label={t().area}
          width={{ min: 360, default: 440 }}
          scrollKey="admin-storage"
          status={<StatusRow lead={t().bucketCount({ count: items().length })} />}
        >
          <Show when={props.items !== null} fallback={<Failed text={t().loadFailed} onRetry={() => navigateTo(STORAGE_AREA_HREF)} />}>
            <Table
              label={t().area}
              rows={items()}
              rowKey={(row) => row.id}
              current={currentKey()}
              open={(row) => ({ href: storageBucketHref(row.id) })}
              empty={{ icon: "database", text: t().noFurther, action: add }}
              group={(row) => ({ key: row.isDefault ? "default" : "further", head: () => (row.isDefault ? t().defaultName : t().further) })}
              phone={(row) => ({
                lines: [storageBucketName(t(), row), storageBucketLine(t(), row)],
                marks: <StateChip t={t()} bucket={row} />,
              })}
              columns={[
                {
                  title: t().name,
                  width: { min: 200, default: 260 },
                  cell: (row) => ({ lines: [storageBucketName(t(), row), storageBucketLine(t(), row)] }),
                },
                { title: t().state, cell: (row) => <StateChip t={t()} bucket={row} /> },
              ]}
            />
            <Show when={items().length > 0 && items().every((bucket) => bucket.isDefault)}>
              <Text muted>{t().noFurther}</Text>
            </Show>
          </Show>
        </Pane>
        {props.items !== null && props.selection.kind !== "none" ? (
          <Pane
            detail
            label={detailTitle()}
            back={{ label: t().area, href: STORAGE_AREA_HREF }}
            head={
              <Bar
                start={<Text type="body">{detailTitle()}</Text>}
                end={<Button variant="ghost" icon="x" label={t().cancel} href={STORAGE_AREA_HREF} />}
              />
            }
          >
            {detail()}
          </Pane>
        ) : undefined}
      </Pane.Split>
    </AdminWorkspace>
  );
}
