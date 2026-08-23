import { navigateTo, refreshCurrentPath } from "@k2b/ssr/nav";
import { mutation as mutations } from "@k2b/stdlib/solid";
import {
  Button,
  Placeholder,
  prompts,
  SettingsCollection,
  SettingsField,
  SettingsGroup,
  SettingsModal,
  SettingsPanelFooter,
  StatusBadge,
  TextInput,
  toast,
} from "@k2b/ui";
import type { AccessEntry } from "@valentinkolb/cloud/contracts";
import { createEffect, createMemo, createResource, createSignal, For, onCleanup, Show } from "solid-js";
import { apiClient } from "@/api/client";
import type { PublicBase } from "../../../api/public-dto";
import type { DocumentDefaults } from "../../../contracts";
import { createDraft } from "../editor-draft";
import { ScopedPermissionEditor } from "../permissions/ScopedPermissionEditor";
import { errorMessage } from "../utils/api-helpers";

type DocumentDefaultsDraft = Required<Record<keyof DocumentDefaults, string>>;

const normalizeDocumentDefaults = (defaults: DocumentDefaults = {}): DocumentDefaultsDraft => ({
  legalName: defaults.legalName ?? "",
  senderLine: defaults.senderLine ?? "",
  address: defaults.address ?? "",
  department: defaults.department ?? "",
  contactEmail: defaults.contactEmail ?? "",
  phone: defaults.phone ?? "",
  url: defaults.url ?? "",
  taxId: defaults.taxId ?? "",
  registration: defaults.registration ?? "",
  bankName: defaults.bankName ?? "",
  iban: defaults.iban ?? "",
  bic: defaults.bic ?? "",
  paymentTerms: defaults.paymentTerms ?? "",
  footerText: defaults.footerText ?? "",
});

const cleanDocumentDefaults = (draft: DocumentDefaultsDraft): DocumentDefaults => {
  const entries = Object.entries(draft)
    .map(([key, value]) => [key, value.trim()] as const)
    .filter(([, value]) => value.length > 0);
  return Object.fromEntries(entries) as DocumentDefaults;
};

export function DocumentDefaultsForm(props: {
  base: { id: string; documentDefaults: DocumentDefaults };
  onDirtyChange: (dirty: boolean) => void;
  onSavingChange: (saving: boolean) => void;
}) {
  const initial = normalizeDocumentDefaults(props.base.documentDefaults);
  const [saved, setSaved] = createSignal(initial);
  const draft = createDraft(initial);
  const patch = (partial: Partial<DocumentDefaultsDraft>) => draft.patch(partial);
  const value =
    <K extends keyof DocumentDefaultsDraft>(key: K) =>
    () =>
      draft.draft()[key];

  const changeCount = createMemo(
    () => (Object.keys(saved()) as Array<keyof DocumentDefaultsDraft>).filter((key) => draft.draft()[key] !== saved()[key]).length,
  );
  createEffect(() => props.onDirtyChange(changeCount() > 0));
  onCleanup(() => props.onDirtyChange(false));

  const mutation = mutations.create<PublicBase, DocumentDefaults>({
    mutation: async (documentDefaults, { abortSignal }) => {
      const res = await apiClient.bases[":baseId"].$patch(
        {
          param: { baseId: props.base.id },
          json: { documentDefaults },
        },
        { init: { signal: abortSignal } },
      );
      if (!res.ok) throw new Error(await errorMessage(res, "Failed to save document defaults"));
      return res.json();
    },
    onSuccess: (next) => {
      const snapshot = normalizeDocumentDefaults(next.documentDefaults);
      setSaved(snapshot);
      draft.markSaved(snapshot);
      toast.success("Document details saved");
      refreshCurrentPath();
    },
    onError: (e) => prompts.error(e.message),
  });
  createEffect(() => props.onSavingChange(mutation.loading()));
  onCleanup(() => {
    mutation.abort();
    props.onSavingChange(false);
  });

  return (
    <>
      <SettingsGroup title="Business identity" description="Names and address shown on generated documents.">
        <div class="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <TextInput
            label="Legal name"
            icon="ti ti-building"
            value={value("legalName")}
            onValueChange={(v) => patch({ legalName: v })}
            disabled={mutation.loading()}
          />
          <TextInput
            label="Department"
            icon="ti ti-users"
            value={value("department")}
            onValueChange={(v) => patch({ department: v })}
            disabled={mutation.loading()}
          />
          <div class="lg:col-span-2">
            <TextInput
              label="Sender line"
              description="Shown above recipient address blocks."
              icon="ti ti-mail-forward"
              value={value("senderLine")}
              onValueChange={(v) => patch({ senderLine: v })}
              disabled={mutation.loading()}
            />
          </div>
          <div class="lg:col-span-2">
            <TextInput
              label="Address"
              icon="ti ti-map-pin"
              value={value("address")}
              onValueChange={(v) => patch({ address: v })}
              multiline
              lines={3}
              disabled={mutation.loading()}
            />
          </div>
        </div>
      </SettingsGroup>

      <SettingsGroup title="Contact" description="Contact details available to templates.">
        <div class="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <TextInput
            label="Contact email"
            icon="ti ti-mail"
            value={value("contactEmail")}
            onValueChange={(v) => patch({ contactEmail: v })}
            disabled={mutation.loading()}
          />
          <TextInput
            label="Phone"
            icon="ti ti-phone"
            value={value("phone")}
            onValueChange={(v) => patch({ phone: v })}
            disabled={mutation.loading()}
          />
          <div class="lg:col-span-2">
            <TextInput
              label="Website"
              icon="ti ti-link"
              value={value("url")}
              onValueChange={(v) => patch({ url: v })}
              disabled={mutation.loading()}
            />
          </div>
        </div>
      </SettingsGroup>

      <SettingsGroup title="Billing and footer" description="Payment, registration, and closing details for documents.">
        <div class="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <TextInput
            label="Tax ID / VAT"
            icon="ti ti-receipt-tax"
            value={value("taxId")}
            onValueChange={(v) => patch({ taxId: v })}
            disabled={mutation.loading()}
          />
          <TextInput
            label="Registration"
            icon="ti ti-certificate"
            value={value("registration")}
            onValueChange={(v) => patch({ registration: v })}
            disabled={mutation.loading()}
          />
          <TextInput
            label="Bank"
            icon="ti ti-building-bank"
            value={value("bankName")}
            onValueChange={(v) => patch({ bankName: v })}
            disabled={mutation.loading()}
          />
          <TextInput
            label="IBAN"
            icon="ti ti-credit-card"
            value={value("iban")}
            onValueChange={(v) => patch({ iban: v })}
            disabled={mutation.loading()}
          />
          <TextInput
            label="BIC"
            icon="ti ti-credit-card"
            value={value("bic")}
            onValueChange={(v) => patch({ bic: v })}
            disabled={mutation.loading()}
          />
          <div class="lg:col-span-2">
            <TextInput
              label="Payment terms"
              icon="ti ti-calendar-dollar"
              value={value("paymentTerms")}
              onValueChange={(v) => patch({ paymentTerms: v })}
              multiline
              lines={2}
              disabled={mutation.loading()}
            />
          </div>
          <div class="lg:col-span-2">
            <TextInput
              label="Footer text"
              icon="ti ti-text-caption"
              value={value("footerText")}
              onValueChange={(v) => patch({ footerText: v })}
              multiline
              lines={2}
              disabled={mutation.loading()}
            />
          </div>
        </div>
      </SettingsGroup>

      <SettingsModal.Footer>
        <SettingsPanelFooter
          changeCount={changeCount}
          loading={mutation.loading}
          onDiscard={draft.reset}
          onSave={() => mutation.mutate(cleanDocumentDefaults(draft.draft()))}
        />
      </SettingsModal.Footer>
    </>
  );
}

export function TrashSection(props: { baseId: string }) {
  // Lazy-load on mount via createResource — trash is base-admin-only
  // and rarely viewed, so we don't bloat the SSR payload with it.
  const [trash, { refetch }] = createResource(async () => {
    const res = await apiClient.bases[":baseId"].trash.$get({ param: { baseId: props.baseId } });
    if (!res.ok) throw new Error(await errorMessage(res, "Failed to load trash"));
    return res.json();
  });
  const [restoringId, setRestoringId] = createSignal<string | null>(null);
  const items = createMemo(() => {
    const current = trash();
    if (!current) return [];
    return [
      ...current.tables.map((item) => ({ ...item, kind: "Table" as const, icon: "ti-table" })),
      ...current.fields.map((item) => ({ ...item, kind: "Field" as const, icon: "ti-columns" })),
      ...current.forms.map((item) => ({ ...item, kind: "Form" as const, icon: "ti-forms" })),
    ].sort((left, right) => (right.deletedAt ?? "").localeCompare(left.deletedAt ?? ""));
  });
  type TrashItem = ReturnType<typeof items>[number];

  const restore = async (item: TrashItem) => {
    if (restoringId()) return;
    const itemId = item.id;
    if (!itemId) return;
    setRestoringId(itemId);
    try {
      const response =
        item.kind === "Table"
          ? await apiClient.tables[":tableId"].restore.$post({ param: { tableId: itemId } })
          : item.kind === "Field"
            ? await apiClient.fields[":fieldId"].restore.$post({ param: { fieldId: itemId } })
            : await apiClient.forms[":formId"].restore.$post({ param: { formId: itemId } });
      if (!response.ok) throw new Error(await errorMessage(response, `Failed to restore ${item.kind.toLowerCase()}`));
      toast.success(`${item.kind} restored`);
      await refetch();
      if (trash.error) prompts.error(`${item.kind} was restored, but the trash list could not be refreshed.`);
      if (item.kind === "Table") refreshCurrentPath();
    } catch (error) {
      prompts.error(error instanceof Error ? error.message : `Failed to restore ${item.kind.toLowerCase()}`);
    } finally {
      setRestoringId(null);
    }
  };

  const formatDeletedAt = (iso: string | null) => {
    if (!iso) return "";
    const date = new Date(iso);
    return date.toLocaleDateString();
  };

  return (
    <Show when={!trash.loading} fallback={<Placeholder state="loading" variant="compact" title="Loading trash" />}>
      <Show
        when={!trash.error}
        fallback={
          <Placeholder
            state="error"
            variant="compact"
            title="Trash is unavailable"
            description={trash.error instanceof Error ? trash.error.message : "Failed to load trash"}
            action={
              <Button variant="secondary" size="sm" type="button" onClick={() => void refetch()}>
                Retry
              </Button>
            }
          />
        }
      >
        <SettingsCollection title="Recently deleted" description="Restore tables, fields, and forms to this Base." empty="Trash is empty.">
          <For each={items()}>
            {(item) => (
              <SettingsCollection.Item
                title={item.name}
                description={item.deletedAt ? `Deleted ${formatDeletedAt(item.deletedAt)}` : "Deletion time unavailable"}
                icon={<i class={`ti ${item.icon}`} aria-hidden="true" />}
              >
                <SettingsCollection.Item.Status>
                  <StatusBadge tone="neutral" label={item.kind} icon={null} />
                </SettingsCollection.Item.Status>
                <SettingsCollection.Item.Actions>
                  <Button
                    variant="secondary"
                    size="sm"
                    type="button"
                    loading={restoringId() === item.id}
                    loadingLabel={`Restoring ${item.name}`}
                    disabled={restoringId() !== null}
                    onClick={() => void restore(item)}
                  >
                    <i class="ti ti-arrow-back-up" aria-hidden="true" /> Restore
                  </Button>
                </SettingsCollection.Item.Actions>
              </SettingsCollection.Item>
            )}
          </For>
        </SettingsCollection>
      </Show>
    </Show>
  );
}

export function GeneralForm(props: {
  base: { id: string; name: string; description: string | null };
  onDirtyChange: (dirty: boolean) => void;
  onSavingChange: (saving: boolean) => void;
}) {
  const initial = {
    name: props.base.name,
    description: props.base.description ?? "",
  };
  const [saved, setSaved] = createSignal(initial);
  const draft = createDraft(initial);
  const patch = (partial: Partial<ReturnType<typeof draft.draft>>) => {
    draft.patch(partial);
  };
  const name = () => draft.draft().name;
  const description = () => draft.draft().description;
  const changeCount = () => Number(name() !== saved().name) + Number(description() !== saved().description);
  createEffect(() => props.onDirtyChange(draft.dirty()));
  onCleanup(() => props.onDirtyChange(false));

  const mutation = mutations.create<PublicBase, { name: string; description: string }>({
    mutation: async (intent, { abortSignal }) => {
      const res = await apiClient.bases[":baseId"].$patch(
        {
          param: { baseId: props.base.id },
          json: { name: intent.name, description: intent.description || null },
        },
        { init: { signal: abortSignal } },
      );
      if (!res.ok) throw new Error(await errorMessage(res, "Failed to save"));
      return res.json();
    },
    onSuccess: (next) => {
      const snapshot = {
        name: next.name,
        description: next.description ?? "",
      };
      setSaved(snapshot);
      draft.markSaved(snapshot);
      toast.success("Base details saved");
      refreshCurrentPath();
    },
    onError: (e) => prompts.error(e.message),
  });
  createEffect(() => props.onSavingChange(mutation.loading()));
  onCleanup(() => {
    mutation.abort();
    props.onSavingChange(false);
  });

  const save = () => {
    const intent = { name: name().trim(), description: description().trim() };
    if (!intent.name || mutation.loading()) return;
    mutation.mutate(intent);
  };

  return (
    <>
      <SettingsGroup title="Identity" description="Describe this Base wherever it appears in Grids.">
        <SettingsField
          label="Name"
          description="Shown in navigation, the overview, and Base selectors."
          error={() => (!name().trim() ? "Name is required" : undefined)}
          changed={() => name() !== saved().name}
        >
          {(control) => (
            <TextInput
              aria-label="Name"
              aria-describedby={control.describedBy()}
              placeholder="My Base"
              icon="ti ti-typography"
              value={name}
              onValueChange={(v) => patch({ name: v })}
              onSubmit={save}
              required
              disabled={mutation.loading()}
            />
          )}
        </SettingsField>
        <SettingsField
          label="Description"
          description="Optional context for people who can access this Base."
          error={() => undefined}
          changed={() => description() !== saved().description}
        >
          {(control) => (
            <TextInput
              aria-label="Description"
              aria-describedby={control.describedBy()}
              placeholder="What is this Base for?"
              icon="ti ti-align-left"
              value={description}
              onValueChange={(v) => patch({ description: v })}
              multiline
              lines={3}
              disabled={mutation.loading()}
            />
          )}
        </SettingsField>
      </SettingsGroup>

      <SettingsModal.Footer>
        <SettingsPanelFooter
          changeCount={changeCount}
          loading={mutation.loading}
          saveDisabled={() => !name().trim()}
          onDiscard={draft.reset}
          onSave={save}
        />
      </SettingsModal.Footer>
    </>
  );
}

export function PermissionsSection(props: { baseId: string; initialEntries: AccessEntry[] }) {
  return <ScopedPermissionEditor scope={{ type: "base", id: props.baseId }} initialEntries={props.initialEntries} canEdit />;
}

export function DangerZone(props: { baseId: string; baseName: string; onSavingChange: (saving: boolean) => void }) {
  const deleteMut = mutations.create<void, void>({
    mutation: async (_, { abortSignal }) => {
      const res = await apiClient.bases[":baseId"].$delete({ param: { baseId: props.baseId } }, { init: { signal: abortSignal } });
      // hono-openapi typed client only declares non-204 statuses; check range manually.
      if (res.status >= 400) throw new Error(await errorMessage(res, "Failed to move Base to trash"));
    },
    onSuccess: () => navigateTo("/app/grids"),
    onError: (e) => prompts.error(e.message),
  });
  createEffect(() => props.onSavingChange(deleteMut.loading()));
  onCleanup(() => {
    deleteMut.abort();
    props.onSavingChange(false);
  });

  const handleDelete = async () => {
    const confirmed = await prompts.confirm(`Move "${props.baseName}" and its tables out of the active app? The Base remains restorable.`, {
      title: "Move Base to trash?",
      variant: "danger",
      confirmText: "Move to trash",
    });
    if (!confirmed) return;
    deleteMut.mutate(undefined);
  };

  return (
    <Button
      variant="danger"
      size="sm"
      type="button"
      onClick={handleDelete}
      loading={deleteMut.loading()}
      loadingLabel="Moving Base to trash"
    >
      <i class="ti ti-trash mr-1" aria-hidden="true" />
      Move to trash
    </Button>
  );
}
