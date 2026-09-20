import { PermissionEditor } from "@k2b/cloud/access/ui";
import { query } from "@k2b/stdlib/solid";
import {
  Button,
  DataTable,
  dialogCore,
  FileDropzone,
  Format,
  IconButton,
  InlineGuidance,
  NoticeCard,
  PanelDialog,
  Placeholder,
  panelDialogOptions,
  prompts,
  Select,
  TextInput,
  toast,
} from "@k2b/ui";
import { createSignal, For, Show } from "solid-js";
import { apiClient } from "../api/client";
import { TEMPLATE_LIMIT } from "../document-assets";
import type { FileTemplate } from "../template-contracts";
import { useAssetMessages } from "./asset-messages";
import { apiFailure } from "./file-preview";

async function read<T>(response: { ok: boolean; json: () => Promise<T> }, fallback: string): Promise<T> {
  if (!response.ok) return apiFailure(response, fallback);
  return response.json();
}
export function openTemplatePicker() {
  return dialogCore.open<FileTemplate | null>((close) => <TemplatePicker close={close} />, panelDialogOptions);
}
function TemplatePicker(props: { close: (value: FileTemplate | null) => void }) {
  const t = useAssetMessages();
  return (
    <PanelDialog>
      <PanelDialog.Header title={t().template} subtitle={t().templateHint} icon="ti ti-file-description" close={() => props.close(null)} />
      <PanelDialog.Body>
        <TemplateList onSelect={props.close} />
      </PanelDialog.Body>
    </PanelDialog>
  );
}

export function TemplateList(props: { admin?: boolean; onSelect?: (template: FileTemplate) => void }) {
  const t = useAssetMessages();
  const [search, setSearch] = createSignal("");
  const [filter, setFilter] = createSignal("");
  const [after, setAfter] = createSignal<string>();
  const source = () => JSON.stringify([filter(), after()]);
  const list = query.create({
    source,
    load: async (_, { abortSignal }) =>
      read(
        await (props.admin
          ? apiClient.templates.admin.$get({ query: { q: filter(), after: after() } }, { init: { signal: abortSignal } })
          : apiClient.templates.$get({ query: { q: filter(), after: after() } }, { init: { signal: abortSignal } })),
        t().failed,
      ),
  });
  const run = async (work: () => Promise<unknown>) => {
    try {
      await work();
      await list.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t().failed);
    }
  };
  const remove = async (item: FileTemplate) => {
    if (await prompts.confirm(t().removeQuestion, { title: item.name, variant: "danger" }))
      await run(async () => read(await apiDelete(item.id), t().failed));
  };
  const apiDelete = async (id: string) => apiClient.templates.admin[":id"].$delete({ param: { id } });
  return (
    <div class="flex min-w-0 flex-col gap-3">
      <Show when={props.admin}>
        <NoticeCard tone="info" title={t().templates} detail={t().snapshot} />
        <div>
          <Button
            onClick={() =>
              void openTemplateForm().then((saved) => {
                if (saved) void list.refresh();
              })
            }
          >
            <i class="ti ti-plus" aria-hidden="true" />
            {t().newTemplate}
          </Button>
        </div>
      </Show>
      <form
        class="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setAfter(undefined);
          setFilter(search());
        }}
      >
        <div class="min-w-0 flex-1">
          <TextInput aria-label={t().search} placeholder={t().search} value={search()} onValueChange={setSearch} />
        </div>
        <IconButton label={t().search} type="submit" variant="input">
          <i class="ti ti-search" aria-hidden="true" />
        </IconButton>
      </form>
      <div class="filesv2-template-list">
        <Show when={!list.loading()} fallback={<Placeholder state="loading" title={t().loading} />}>
          <Show
            when={!list.error()}
            fallback={
              <Placeholder
                state="error"
                title={t().failed}
                description={list.error()?.message}
                action={<Button onClick={() => void list.refresh()}>{t().retry}</Button>}
              />
            }
          >
            <Show when={list.data()?.items.length} fallback={<Placeholder title={t().empty} description={t().emptyDetail} />}>
              <DataTable
                rows={list.data()?.items ?? []}
                getRowId={(row) => row.id}
                density="compact"
                columns={[
                  { id: "name", header: t().name },
                  { id: "actions", header: "", align: "right" },
                ]}
                renderCell={({ row, col }) =>
                  col.id === "name" ? (
                    <div>
                      <div class="font-medium">{row.name}</div>
                      <div class="text-sm text-dimmed">
                        {row.filename} · <Format.Bytes value={row.size} />
                      </div>
                      <Show when={row.description}>
                        <p class="text-sm text-dimmed">{row.description}</p>
                      </Show>
                    </div>
                  ) : (
                    <Show
                      when={props.admin}
                      fallback={
                        <Button size="sm" onClick={() => props.onSelect?.(row)}>
                          {t().choose}
                        </Button>
                      }
                    >
                      <div class="flex flex-wrap justify-end gap-2">
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() =>
                            void openTemplateForm(row).then((saved) => {
                              if (saved) void list.refresh();
                            })
                          }
                        >
                          {t().edit}
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() =>
                            void dialogCore.open(
                              (close) => <TemplateAccess id={row.id} name={row.name} close={() => close(null)} />,
                              panelDialogOptions,
                            )
                          }
                        >
                          {t().permissions}
                        </Button>
                        <Button size="sm" variant="secondary" onClick={() => void remove(row)}>
                          {t().remove}
                        </Button>
                      </div>
                    </Show>
                  )
                }
              />
            </Show>
          </Show>
        </Show>
      </div>
      <div class="flex justify-between gap-2">
        <Show when={after()}>
          <Button variant="secondary" onClick={() => setAfter(undefined)}>
            <i class="ti ti-arrow-left" aria-hidden="true" />
            {t().first}
          </Button>
        </Show>
        <Show when={list.data()?.next}>
          {(next) => (
            <Button variant="secondary" onClick={() => setAfter(next())}>
              {t().more}
            </Button>
          )}
        </Show>
      </div>
    </div>
  );
}
function openTemplateForm(item?: FileTemplate) {
  return dialogCore.open<boolean>(
    (close, context) => <TemplateForm item={item} close={close} setDismissHandler={context.setDismissHandler} />,
    panelDialogOptions,
  );
}
function TemplateForm(props: {
  item?: FileTemplate;
  close: (saved: boolean) => void;
  setDismissHandler: (handler: () => Promise<void>) => void;
}) {
  const t = useAssetMessages();
  const [name, setName] = createSignal(props.item?.name ?? "");
  const [description, setDescription] = createSignal(props.item?.description ?? "");
  const [file, setFile] = createSignal<File>();
  const [source, setSource] = createSignal<{ baseId: string; path: string; name: string }>();
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const cancel = async () => {
    if (busy()) return;
    const changed = name() !== (props.item?.name ?? "") || description() !== (props.item?.description ?? "") || !!file() || !!source();
    if (changed && !(await prompts.confirm(t().discard))) return;
    props.close(false);
  };
  props.setDismissHandler(cancel);
  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    if (busy()) return;
    setBusy(true);
    setError("");
    try {
      let payload: { filename: string; content: string } | undefined;
      const selected = file();
      if (selected) {
        if (selected.size > TEMPLATE_LIMIT) throw new Error(t().budget);
        const bytes = new Uint8Array(await selected.arrayBuffer());
        let binary = "";
        for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
        payload = { filename: selected.name, content: btoa(binary) };
      }
      if (props.item) {
        await read(
          await apiClient.templates.admin[":id"].$patch({
            param: { id: props.item.id },
            json: { name: name(), description: description(), file: payload },
          }),
          t().failed,
        );
      } else if (payload)
        await read(await apiClient.templates.admin.$post({ json: { ...payload, name: name(), description: description() } }), t().failed);
      else if (source())
        await read(
          await apiClient.templates.admin.import.$post({
            json: { name: name(), description: description(), source: { baseId: source()!.baseId, path: source()!.path } },
          }),
          t().failed,
        );
      else throw new Error(t().noSelection);
      props.close(true);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t().failed);
    } finally {
      setBusy(false);
    }
  };
  return (
    <PanelDialog>
      <PanelDialog.Header title={props.item ? t().edit : t().newTemplate} subtitle={props.item?.name} close={() => void cancel()} />
      <PanelDialog.Body>
        <form id="filesv2-template-form" class="flex flex-col gap-4" onSubmit={(event) => void submit(event)}>
          <TextInput label={t().name} value={name()} onValueChange={setName} required maxLength={160} disabled={busy()} />
          <TextInput label={t().description} value={description()} onValueChange={setDescription} maxLength={2000} disabled={busy()} />
          <InlineGuidance>{t().snapshot}</InlineGuidance>
          <FileDropzone
            label={props.item ? t().replace : t().upload}
            multiple={false}
            busy={busy()}
            hint={t().budget}
            onDrop={(files) => {
              const next = files[0];
              if (next && next.size > TEMPLATE_LIMIT) {
                setError(t().budget);
                return;
              }
              setFile(next);
              setSource(undefined);
              if (!name()) setName(next?.name ?? "");
            }}
          />
          <Show when={file()}>{(value) => <span class="text-sm">{value().name}</span>}</Show>
          <Show when={!props.item}>
            <Button
              variant="secondary"
              disabled={busy()}
              onClick={() =>
                void dialogCore
                  .open<{ baseId: string; path: string; name: string } | null>(
                    (close) => <SourcePicker close={close} />,
                    panelDialogOptions,
                  )
                  .then((value) => {
                    if (value) {
                      setSource(value);
                      setFile(undefined);
                      if (!name()) setName(value.name);
                    }
                  })
              }
            >
              {t().source}
            </Button>
            <Show when={source()}>{(value) => <span class="text-sm break-all">{value().path}</span>}</Show>
          </Show>
          <Show when={error()}>
            <InlineGuidance tone="warning">{error()}</InlineGuidance>
          </Show>
        </form>
      </PanelDialog.Body>
      <PanelDialog.Footer>
        <Button variant="secondary" disabled={busy()} onClick={() => void cancel()}>
          {t().close}
        </Button>
        <Button type="submit" form="filesv2-template-form" disabled={busy() || !name().trim()}>
          {busy() ? t().saving : t().save}
        </Button>
      </PanelDialog.Footer>
    </PanelDialog>
  );
}
function TemplateAccess(props: { id: string; name: string; close: () => void }) {
  const t = useAssetMessages();
  const entries = query.create({
    source: () => props.id,
    load: async (id, { abortSignal }) =>
      read(await apiClient.templates.admin[":id"].grants.$get({ param: { id } }, { init: { signal: abortSignal } }), t().failed),
  });
  return (
    <PanelDialog>
      <PanelDialog.Header title={t().permissions} subtitle={props.name} close={props.close} />
      <PanelDialog.Body>
        <InlineGuidance>{t().grantsHint}</InlineGuidance>
        <Show when={!entries.loading()} fallback={<Placeholder state="loading" title={t().loading} />}>
          <Show
            when={entries.data()}
            keyed
            fallback={
              <Placeholder state="error" title={t().failed} action={<Button onClick={() => void entries.refresh()}>{t().retry}</Button>} />
            }
          >
            {(items) => (
              <PermissionEditor
                initialEntries={items}
                canEdit
                allowPublic={false}
                allowServiceAccounts={false}
                allowedLevels={[{ level: "read", label: t().use }]}
                grantAccess={async (principal) => {
                  if (principal.type === "public" || principal.type === "service_account") throw new Error(t().failed);
                  return read(
                    await apiClient.templates.admin[":id"].grants.$post({ param: { id: props.id }, json: { principal } }),
                    t().failed,
                  );
                }}
                updateAccess={async () => {}}
                revokeAccess={async (accessId) => {
                  await read(
                    await apiClient.templates.admin[":id"].grants[":accessId"].$delete({ param: { id: props.id, accessId } }),
                    t().failed,
                  );
                }}
              />
            )}
          </Show>
        </Show>
      </PanelDialog.Body>
    </PanelDialog>
  );
}
function SourcePicker(props: { close: (value: { baseId: string; path: string; name: string } | null) => void }) {
  const t = useAssetMessages();
  const [base, setBase] = createSignal("");
  const [path, setPath] = createSignal("");
  const [after, setAfter] = createSignal<string>();
  const bases = query.create({
    source: () => true,
    load: async (_, { abortSignal }) => read(await apiClient.bases.$get({}, { init: { signal: abortSignal } }), t().failed),
  });
  const files = query.create({
    source: () => JSON.stringify([base(), path(), after()]),
    enabled: () => !!base(),
    load: async (_, { abortSignal }) =>
      read(
        await apiClient.bases[":baseId"].entries.$get(
          { param: { baseId: base() }, query: { path: path(), after: after() } },
          { init: { signal: abortSignal } },
        ),
        t().failed,
      ),
  });
  const folder = (value: string) => {
    setAfter(undefined);
    setPath(value);
  };
  return (
    <PanelDialog>
      <PanelDialog.Header title={t().source} subtitle={t().importHint} close={() => props.close(null)} />
      <PanelDialog.Body>
        <div class="flex flex-col gap-3">
          <Select
            aria-label={t().source}
            value={base()}
            onValueChange={(value) => {
              setBase(value ?? "");
              folder("");
            }}
            options={(bases.data()?.items ?? [])
              .filter((item) => item.status === "existing")
              .map((item) => ({ value: item.id, label: item.name }))}
          />
          <span class="break-all text-sm">{path() || "/"}</span>
          <Show when={path()}>
            <Button variant="secondary" onClick={() => folder(path().split("/").slice(0, -1).join("/"))}>
              ..
            </Button>
          </Show>
          <div class="filesv2-template-list">
            <Show when={!files.loading() && !bases.loading()} fallback={<Placeholder state="loading" title={t().loading} />}>
              <Show
                when={!files.error() && !bases.error()}
                fallback={
                  <Placeholder
                    state="error"
                    title={t().failed}
                    action={
                      <Button
                        onClick={() => {
                          void bases.refresh();
                          void files.refresh();
                        }}
                      >
                        {t().retry}
                      </Button>
                    }
                  />
                }
              >
                <For each={files.data()?.items} fallback={<Placeholder title={t().selectFile} />}>
                  {(entry) => (
                    <Button
                      variant="ghost"
                      onClick={() =>
                        entry.directory ? folder(entry.path) : props.close({ baseId: base(), path: entry.path, name: entry.name })
                      }
                    >
                      <i class={entry.directory ? "ti ti-folder" : "ti ti-file"} aria-hidden="true" />
                      {entry.name}
                    </Button>
                  )}
                </For>
              </Show>
            </Show>
          </div>
          <Show when={files.data()?.next}>{(next) => <Button onClick={() => setAfter(next())}>{t().more}</Button>}</Show>
        </div>
      </PanelDialog.Body>
    </PanelDialog>
  );
}
