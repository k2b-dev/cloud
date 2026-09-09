import { img } from "@k2b/stdlib/browser";
import { mutation as mutations } from "@k2b/stdlib/solid";
import {
  Button,
  Checkbox,
  CopyButton,
  confirmDiscardIfDirty,
  DetailPanel,
  dialogCore,
  ImageInput,
  NoticeCard,
  PanelDialog,
  panelDialogWideOptions,
  prompts,
  TextInput,
  useLocale,
} from "@k2b/ui";
import { createEffect, createSignal, type JSX, Show } from "solid-js";
import { apiClient } from "@/api/client";
import type { PublicField as Field, PublicForm } from "../../../api/public-dto";
import type { FormValidationRule } from "../../../contracts";
import type { FormFieldEntry } from "../../../service/forms";
import { errorMessage } from "../utils/api-helpers";
import { FormFieldsEditor } from "./FormFieldsEditor";
import { FormValidationsEditor } from "./FormValidationsEditor";
import { gridsFormMessages } from "./messages";

type OpenFormEditorDialogArgs = {
  form: PublicForm;
  tableFields: Field[];
  onSaved?: (next: PublicForm) => void;
  onDelete?: () => Promise<void> | void;
};

export const openFormEditorDialog = (args: OpenFormEditorDialogArgs) =>
  dialogCore.open<void>(
    (close, context) => <FormEditorDialog args={args} close={close} setDismissHandler={context.setDismissHandler} />,
    panelDialogWideOptions,
  );

function FormEditorDialog(props: {
  args: OpenFormEditorDialogArgs;
  close: () => void;
  setDismissHandler: (handler: () => Promise<void>) => void;
}) {
  const locale = useLocale();
  const t = () => gridsFormMessages.resolve([locale()]).t;
  const [dirty, setDirty] = createSignal(false);
  const [pending, setPending] = createSignal(false);
  const [deleting, setDeleting] = createSignal(false);
  const [deleteError, setDeleteError] = createSignal<string>();
  const closeIfClean = async () => {
    if (pending() || deleting()) return;
    if (await confirmDiscardIfDirty(dirty)) props.close();
  };
  props.setDismissHandler(closeIfClean);
  return (
    <PanelDialog>
      <PanelDialog.Header
        title={t().editForm({ name: props.args.form.name })}
        icon="ti ti-forms"
        close={closeIfClean}
        closeDisabled={pending() || deleting()}
      />
      <FormEditor
        form={props.args.form}
        tableFields={props.args.tableFields}
        deleting={deleting()}
        deleteError={deleteError()}
        onDirtyChange={setDirty}
        onPendingChange={setPending}
        onSaved={(next) => {
          setDirty(false);
          props.args.onSaved?.(next);
          props.close();
        }}
        onDelete={async () => {
          if (pending() || deleting()) return;
          const formId = props.args.form.id;
          if (!formId) return;
          setDeleting(true);
          setDeleteError(undefined);
          try {
            if (
              !(await prompts.confirm(t().deleteFormConfirm({ name: props.args.form.name }), {
                title: t().deleteFormQuestion,
                variant: "danger",
                confirmText: t().delete,
              }))
            )
              return;
            const response = await apiClient.forms[":formId"].$delete({ param: { formId } });
            if (!response.ok) throw new Error(await errorMessage(response, t().deleteFormFailed));
            await props.args.onDelete?.();
            props.close();
          } catch (error) {
            setDeleteError(error instanceof Error ? error.message : t().deleteFormFailed);
          } finally {
            setDeleting(false);
          }
        }}
        onCancel={closeIfClean}
      />
    </PanelDialog>
  );
}

const MAX_LONGEST = 1600;
const bannerTransform = async (file: File): Promise<string> => {
  const data = await img.create(file);
  const longest = Math.max(data.width, data.height);
  const scale = Math.min(1, MAX_LONGEST / longest);
  const transformed = scale < 1 ? await img.resize(Math.round(data.width * scale), Math.round(data.height * scale), "fill")(data) : data;
  return img.toBase64("webp", 0.85)(transformed);
};

type SaveFormRequest = {
  closeMainDialog: boolean;
};

function FormEditor(props: {
  form: PublicForm;
  tableFields: Field[];
  onSaved: (next: PublicForm) => void;
  onDelete: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  onPendingChange?: (pending: boolean) => void;
  deleting: boolean;
  deleteError?: string;
  onCancel?: () => void;
}) {
  const locale = useLocale();
  const t = () => gridsFormMessages.resolve([locale()]).t;
  const [name, setName] = createSignal(props.form.name);
  const [isPublic, setIsPublic] = createSignal(Boolean(props.form.publicToken));
  const [isActive, setIsActive] = createSignal(props.form.isActive);
  const [title, setTitle] = createSignal(props.form.config.title ?? "");
  const [description, setDescription] = createSignal(props.form.config.description ?? "");
  const [submitLabel, setSubmitLabel] = createSignal(props.form.config.submitLabel ?? "");
  const [successMessage, setSuccessMessage] = createSignal(props.form.config.successMessage ?? "");
  const [redirectUrl, setRedirectUrl] = createSignal(props.form.config.redirectUrl ?? "");
  const [titleImage, setTitleImage] = createSignal<string | null>(props.form.config.titleImage ?? null);
  const [entries, setEntries] = createSignal<FormFieldEntry[]>(props.form.config.fields.map((entry) => ({ ...entry })));
  const [validations, setValidations] = createSignal<FormValidationRule[]>(
    props.form.config.validations?.map((rule) => ({ ...rule })) ?? [],
  );
  const [dirty, setDirty] = createSignal(false);
  const [nameInvalid, setNameInvalid] = createSignal(false);
  const [confirming, setConfirming] = createSignal(false);
  let nameInput: HTMLInputElement | HTMLTextAreaElement | undefined;

  const markDirty = () => {
    setDirty(true);
    props.onDirtyChange?.(true);
  };
  const wrap =
    <T,>(setter: (value: T) => void) =>
    (value: T) => {
      setter(value);
      markDirty();
    };

  const updateMut = mutations.create<PublicForm, SaveFormRequest, SaveFormRequest>({
    onBefore: (request) => request,
    mutation: async (request) => {
      if (!props.form.id) throw new Error(t().defaultFormCannotEdit);
      const res = await apiClient.forms[":formId"].$patch({
        param: { formId: props.form.id },
        json: {
          name: name().trim(),
          isPublic: isPublic(),
          isActive: isActive(),
          config: {
            ...props.form.config,
            title: title().trim() || undefined,
            description: description().trim() || undefined,
            submitLabel: submitLabel().trim() || undefined,
            successMessage: successMessage().trim() || undefined,
            redirectUrl: redirectUrl().trim() || null,
            titleImage: titleImage() ?? undefined,
            fields: entries(),
            validations: validations().length > 0 ? validations() : undefined,
          },
        },
      });
      if (!res.ok) throw new Error(await errorMessage(res, t().saveFormFailed));
      return res.json();
    },
    onSuccess: (next, request) => {
      setEntries(next.config.fields.map((entry) => ({ ...entry })));
      setValidations(next.config.validations?.map((rule) => ({ ...rule })) ?? []);
      setDirty(false);
      props.onDirtyChange?.(false);
      if (request?.closeMainDialog) props.onSaved(next);
    },
  });
  const pending = () => updateMut.loading() || confirming() || props.deleting;
  createEffect(() => props.onPendingChange?.(updateMut.loading() || confirming()));

  const handleSave = async () => {
    if (pending()) return;
    if (!name().trim()) {
      setNameInvalid(true);
      nameInput?.focus();
      return;
    }
    if (props.form.publicToken && props.form.isActive) {
      setConfirming(true);
      const confirmed = await prompts.confirm(t().liveFormWarning, { title: t().saveLiveForm, confirmText: t().save });
      setConfirming(false);
      if (!confirmed) return;
    }
    void updateMut.mutate({ closeMainDialog: true });
  };

  return (
    <>
      <PanelDialog.Body>
        <Show when={props.deleteError}>{(error) => <NoticeCard tone="danger" title={error()} />}</Show>
        <Show when={updateMut.error()}>
          {(error) => (
            <NoticeCard
              tone="danger"
              title={t().saveFormFailed}
              detail={error().message === t().saveFormFailed ? undefined : error().message}
            />
          )}
        </Show>
        <fieldset disabled={pending()} class="flex flex-col gap-4 min-w-0">
          <div class="grid grid-cols-1 md:grid-cols-2 gap-3 items-end">
            <TextInput
              label={t().name}
              description={t().nameDescription}
              value={name}
              onValueChange={wrap(setName)}
              icon="ti ti-typography"
              required
              ref={(element) => {
                nameInput = element;
              }}
              error={() => (nameInvalid() && !name().trim() ? t().nameRequired : undefined)}
            />
            <TextInput
              label={t().title}
              description={t().titleDescription}
              value={title}
              onValueChange={wrap(setTitle)}
              icon="ti ti-heading"
              placeholder={name()}
            />
          </div>
          <FormEditorSection primary title={t().fields} subtitle={t().fieldsDescription} icon="ti ti-forms">
            <FormFieldsEditor
              tableFields={props.tableFields}
              entries={entries}
              setEntries={(next) => {
                setEntries(next);
                markDirty();
              }}
            />
          </FormEditorSection>

          <FormEditorSection title={t().appearance} icon="ti ti-palette">
            <TextInput
              label={t().description}
              description={t().descriptionDescription}
              value={description}
              onValueChange={wrap(setDescription)}
              icon="ti ti-align-left"
              multiline
              lines={2}
            />
            <ImageInput
              label={t().titleImage}
              description={t().titleImageDescription}
              value={titleImage}
              onValueChange={wrap(setTitleImage)}
              transform={bannerTransform}
            />
          </FormEditorSection>

          <FormEditorSection title={t().availability} subtitle={t().availabilityDescription} icon="ti ti-world">
            <Checkbox label={t().active} description={t().activeDescription} value={isActive} onValueChange={wrap(setIsActive)} />
            <div class="flex items-center gap-3 flex-wrap">
              <Checkbox
                label={t().public}
                description={t().publicDescription}
                value={isPublic}
                onValueChange={async (next) => {
                  if (!next && props.form.publicToken) {
                    const confirmed = await prompts.confirm(t().disablePublicWarning, {
                      title: t().disablePublicLink,
                      variant: "danger",
                      confirmText: t().disable,
                    });
                    if (!confirmed) {
                      setIsPublic(false);
                      queueMicrotask(() => setIsPublic(true));
                      return;
                    }
                  }
                  wrap(setIsPublic)(next);
                }}
              />
              <Show when={props.form.publicToken}>
                {(token) => (
                  <CopyButton
                    text={`${typeof window === "undefined" ? "" : window.location.origin}/share/grids/forms/${token()}`}
                    variant="ghost"
                    size="sm"
                  />
                )}
              </Show>
            </div>
          </FormEditorSection>

          <FormEditorSection title={t().submission} subtitle={t().submissionDescription} icon="ti ti-send">
            <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
              <TextInput
                label={t().submitButtonLabel}
                description={t().defaultsToSave}
                value={submitLabel}
                onValueChange={wrap(setSubmitLabel)}
                icon="ti ti-send"
                placeholder={t().save}
              />
              <TextInput
                label={t().successMessage}
                description={t().successMessageDescription}
                value={successMessage}
                onValueChange={wrap(setSuccessMessage)}
                icon="ti ti-circle-check"
                placeholder={t().saved}
              />
            </div>
            <TextInput
              label={t().redirectUrl}
              description={t().redirectUrlDescription}
              value={redirectUrl}
              onValueChange={wrap(setRedirectUrl)}
              icon="ti ti-external-link"
              placeholder="https://example.com/thanks"
              type="url"
            />
          </FormEditorSection>

          <FormEditorSection title={t().crossFieldValidation} subtitle={t().crossFieldValidationDescription} icon="ti ti-arrows-left-right">
            <FormValidationsEditor
              fields={props.tableFields}
              entries={entries()}
              rules={validations()}
              onChange={(next) => {
                setValidations(next);
                markDirty();
              }}
            />
          </FormEditorSection>
        </fieldset>
      </PanelDialog.Body>

      <PanelDialog.Footer>
        <Button
          variant="ghost"
          size="sm"
          type="button"
          class="text-red-500 hover:text-red-600"
          onClick={props.onDelete}
          disabled={pending()}
        >
          <i class="ti ti-trash" /> {t().deleteForm}
        </Button>
        <div class="flex items-center gap-2">
          <Show when={props.onCancel}>
            <Button variant="secondary" size="sm" type="button" onClick={() => props.onCancel?.()} disabled={pending()}>
              {t().cancel}
            </Button>
          </Show>
          <Button
            variant="primary"
            size="sm"
            type="button"
            onClick={handleSave}
            disabled={!dirty() || confirming()}
            loading={updateMut.loading()}
            loadingLabel={t().savingForm}
          >
            {t().save}
          </Button>
        </div>
      </PanelDialog.Footer>
    </>
  );
}

function FormEditorSection(props: { title: string; subtitle?: string; icon: string; children: JSX.Element; primary?: boolean }) {
  return (
    <Show
      when={props.primary}
      fallback={
        <DetailPanel.Section collapsible title={props.title} description={props.subtitle} icon={props.icon}>
          <div class="flex flex-col gap-4 min-w-0">{props.children}</div>
        </DetailPanel.Section>
      }
    >
      <PanelDialog.Section title={props.title} subtitle={props.subtitle} icon={props.icon}>
        {props.children}
      </PanelDialog.Section>
    </Show>
  );
}
