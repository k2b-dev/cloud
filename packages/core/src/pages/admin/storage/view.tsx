import type { AdminStorageBucket } from "@k2b/cloud/contracts/storage-buckets";
import { AdminAreaSaveStatusFoot, AdminAreaSaveStatusHead, AdminLayout } from "@k2b/cloud/ssr";
import { AppWorkspace, ButtonLink, Placeholder, SettingsField, SettingsSection, StatusBadge } from "@k2b/ui";
import { type JSX, Show } from "solid-js";
import RegistryForm from "../_area/RegistryForm.island";
import DocumentationLink from "../settings/_components/DocumentationLink";
import type { SettingFieldDef } from "../settings/_components/setting-field";
import { type StorageAreaMessages, storageAreaMessages } from "./messages";
import {
  STORAGE_AREA_HREF,
  STORAGE_STATE_TONE,
  storageBucketHref,
  storageBucketLine,
  storageBucketName,
  storageBucketState,
  storageStateLabel,
  storageStateLabels,
} from "./presentation";
import StorageBucketDetail from "./StorageBucketDetail.island";
import StorageDefaultDetail from "./StorageDefaultDetail.island";
import StorageDetailActions from "./StorageDetailActions.island";

/** What the address opens: nothing chosen (the default bucket shows), a bucket, the form for a new one, or an unknown ID. */
export type StorageSelection = { kind: "none" } | { kind: "new" } | { kind: "bucket"; bucket: AdminStorageBucket } | { kind: "unknown" };

const CONNECTION_KEYS = ["storage.endpoint", "storage.region", "storage.bucket", "storage.access_key_id", "storage.secret_access_key"];

const BucketRow = (props: { t: StorageAreaMessages; bucket: AdminStorageBucket; active: boolean }) => {
  const state = storageBucketState(props.bucket);
  return (
    <AppWorkspace.SidebarItem
      variant="object"
      href={storageBucketHref(props.bucket.id)}
      active={props.active}
      description={storageBucketLine(props.t, props.bucket)}
      meta={
        <StatusBadge
          tone={STORAGE_STATE_TONE[state]}
          variant="text"
          label={storageStateLabel(props.t, state)}
          labels={storageStateLabels(props.t)}
        />
      }
    >
      <span class={props.bucket.removedAt ? "text-(--k2b-text-muted)" : undefined} data-storage-row={props.bucket.id}>
        {storageBucketName(props.t, props.bucket)}
      </span>
    </AppWorkspace.SidebarItem>
  );
};

/** On a phone the level head has no room for the actions; they stay at hand below the form. */
const PhoneActions = (props: { children: JSX.Element }) => (
  <div class="sticky bottom-0 flex justify-end border-t border-(--k2b-border) bg-(--k2b-surface) px-2 py-3 md:hidden">{props.children}</div>
);

/** The Storage area: the buckets as the first column, the open bucket beside it. */
export function StorageView(props: {
  c: Parameters<typeof AdminLayout>[0]["c"];
  locale: string;
  /** `null` when the list could not be read. */
  items: AdminStorageBucket[] | null;
  selection: StorageSelection;
  /** The storage settings that configure the default bucket. */
  defaultEntries: SettingFieldDef[];
  documentationBase?: string;
}) {
  const t = storageAreaMessages.resolve([props.locale]).t;
  const items = props.items ?? [];
  const defaultBucket = items.find((bucket) => bucket.isDefault) ?? null;
  const further = items.filter((bucket) => !bucket.isDefault);
  const open: AdminStorageBucket | null =
    props.selection.kind === "bucket" ? props.selection.bucket : props.selection.kind === "none" ? defaultBucket : null;
  const level = props.selection.kind === "none" ? "area" : "detail";

  const detailTitle =
    props.selection.kind === "new"
      ? t.newBucket
      : props.selection.kind === "unknown"
        ? t.unknownTitle
        : open
          ? storageBucketName(t, open)
          : t.area;
  const detailActions = (place: "head" | "foot"): JSX.Element | undefined => {
    if (props.selection.kind === "new")
      return (
        <div class="flex items-center gap-2">
          <ButtonLink variant="secondary" size="sm" href={STORAGE_AREA_HREF}>
            {t.cancel}
          </ButtonLink>
          <StorageDetailActions save="create" />
        </div>
      );
    if (!open) return undefined;
    if (open.isDefault)
      return (
        <div class="flex items-center gap-2">
          {place === "head" ? <DocumentationLink base={props.documentationBase} topic="storage" /> : null}
          <StorageDetailActions test />
          {place === "head" ? <AdminAreaSaveStatusHead /> : <AdminAreaSaveStatusFoot />}
        </div>
      );
    if (open.removedAt) return <StorageDetailActions restore />;
    return <StorageDetailActions test remove save="save" testLabel={open.check.state === "failed" ? "testAgain" : "test"} />;
  };

  const detail = (): JSX.Element => {
    if (props.items === null) return null;
    if (props.selection.kind === "unknown")
      return (
        <Placeholder
          icon="ti ti-database-off"
          title={t.unknownTitle}
          description={t.unknownDetail}
          action={
            <ButtonLink variant="secondary" size="sm" href={STORAGE_AREA_HREF}>
              {t.area}
            </ButtonLink>
          }
        />
      );
    if (props.selection.kind === "new") return <StorageBucketDetail bucket={null} />;
    if (!open) return null;
    if (!open.isDefault) return <StorageBucketDetail bucket={open} />;
    return (
      <div class="flex flex-col gap-4">
        <StorageDefaultDetail part="status" bucket={open} />
        <SettingsSection title={t.identity} subtitle={t.defaultIdentityHelp}>
          <SettingsField label={t.id} description={t.idHelp} error={undefined}>
            <code class="flex min-h-8 items-center font-mono text-sm" data-storage-bucket-id>
              {open.id}
            </code>
          </SettingsField>
        </SettingsSection>
        <RegistryForm
          groups={["storage"]}
          sections={[
            { title: t.connection, keys: CONNECTION_KEYS },
            { title: t.limits, description: t.maxSize, keys: ["storage.max_object_bytes"] },
          ]}
          entries={props.defaultEntries}
          reloadAfter={CONNECTION_KEYS}
        />
        <StorageDefaultDetail part="usage" bucket={open} />
      </div>
    );
  };

  return (
    <AdminLayout c={props.c} title={t.area} ownMain>
      <AppWorkspace.Main level={level}>
        <AppWorkspace.MainPane
          id="area"
          label={t.area}
          href={STORAGE_AREA_HREF}
          defaultSize={320}
          minSize={280}
          maxSize={440}
          actions={
            <ButtonLink variant="secondary" size="sm" href={storageBucketHref("new")} data-storage-action="add">
              {t.add}
            </ButtonLink>
          }
        >
          <Show
            when={props.items !== null}
            fallback={
              <Placeholder
                state="error"
                icon="ti ti-database-exclamation"
                title={t.loadFailed}
                description={t.loadFailedDetail}
                action={
                  <ButtonLink variant="secondary" size="sm" href={STORAGE_AREA_HREF}>
                    {t.reload}
                  </ButtonLink>
                }
              />
            }
          >
            <nav aria-label={t.area}>
              <AppWorkspace.SidebarSection>
                <Show when={defaultBucket}>{(bucket) => <BucketRow t={t} bucket={bucket()} active={open?.isDefault === true} />}</Show>
              </AppWorkspace.SidebarSection>
              <AppWorkspace.SidebarSection title={t.further}>
                {further.map((bucket) => (
                  <BucketRow t={t} bucket={bucket} active={open?.id === bucket.id} />
                ))}
                <Show when={props.selection.kind === "new"}>
                  <AppWorkspace.SidebarItem
                    variant="object"
                    active
                    description={t.notSaved}
                    meta={<StatusBadge tone="neutral" variant="text" label={t.draft} />}
                  >
                    {t.newBucket}
                  </AppWorkspace.SidebarItem>
                </Show>
                <Show when={further.length === 0 && props.selection.kind !== "new"}>
                  <p class="px-2 py-1 text-sm text-(--k2b-text-muted)" data-storage-empty>
                    {t.noFurther}
                  </p>
                </Show>
              </AppWorkspace.SidebarSection>
            </nav>
          </Show>
        </AppWorkspace.MainPane>
        <AppWorkspace.MainPane
          id="detail"
          label={detailTitle}
          description={open && props.selection.kind !== "new" ? storageBucketLine(t, open) : undefined}
          actions={detailActions("head") ? <div class="hidden md:block">{detailActions("head")}</div> : undefined}
        >
          {detail()}
          <Show when={detailActions("foot")}>{(actions) => <PhoneActions>{actions()}</PhoneActions>}</Show>
        </AppWorkspace.MainPane>
      </AppWorkspace.Main>
    </AdminLayout>
  );
}
