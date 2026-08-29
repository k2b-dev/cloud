import { img } from "@k2b/stdlib/browser";
import { mutation as mutations } from "@k2b/stdlib/solid";
import {
  Button,
  Checkbox,
  CopyButton,
  confirmDiscardIfDirty,
  dialogCore,
  ImageInput,
  PanelDialog,
  panelDialogWideOptions,
  prompts,
  TextInput,
  useLocale,
} from "@k2b/ui";
import { createSignal, type JSX, Show } from "solid-js";
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
  dialogCore.open<void>((close) => <FormEditorDialog args={args} close={close} />, panelDialogWideOptions);

function FormEditorDialog(props: { args: OpenFormEditorDialogArgs; close: () => void }) {
  const locale = useLocale();
  const t = () => gridsFormMessages.resolve([locale()]).t;
  const [dirty, setDirty] = createSignal(false);
  const closeIfClean = async () => {
    if (await confirmDiscardIfDirty(dirty)) props.close();
  };
  return (
    <PanelDialog>
      <PanelDialog.Header title={t().editForm({ name: props.args.form.name })} icon="ti ti-forms" close={closeIfClean} />
      <FormEditor
        form={props.args.form}
        tableFields={props.args.tableFields}
        onDirtyChange={setDirty}
        onSaved={(next) => {
          setDirty(false);
          props.args.onSaved?.(next);
          props.close();
        }}
        onDelete={async () => {
          await props.args.onDelete?.();
          props.close();
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
    onError: (error) => prompts.error(error.message),
  });

  const handleSave = async () => {
    if (!name().trim()) {
      prompts.error(t().nameRequired);
      return;
    }
    if (props.form.publicToken && props.form.isActive) {
      const confirmed = await prompts.confirm(t().liveFormWarning, { title: t().saveLiveForm, confirmText: t().save });
      if (!confirmed) return;
    }
    void updateMut.mutate({ closeMainDialog: true });
  };

  return (
    <>
      <PanelDialog.Body>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
          <TextInput label={t().name} value={name} onValueChange={wrap(setName)} icon="ti ti-typography" required />
          <TextInput
            label={t().title}
            description={t().titleDescription}
            value={title}
            onValueChange={wrap(setTitle)}
            icon="ti ti-heading"
            placeholder={name()}
          />
        </div>
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

        <FormEditorSection title={t().fields} subtitle={t().fieldsDescription} icon="ti ti-forms">
          <FormFieldsEditor
            tableFields={props.tableFields}
            entries={entries}
            setEntries={(next) => {
              setEntries(next);
              markDirty();
            }}
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
      </PanelDialog.Body>

      <PanelDialog.Footer>
        <Button variant="ghost" size="sm" type="button" class="text-red-500 hover:text-red-600" onClick={props.onDelete}>
          <i class="ti ti-trash" /> {t().deleteForm}
        </Button>
        <div class="flex items-center gap-2">
          <Show when={props.onCancel}>
            <Button variant="secondary" size="sm" type="button" onClick={() => props.onCancel?.()}>
              {t().cancel}
            </Button>
          </Show>
          <Button
            variant="primary"
            size="sm"
            type="button"
            onClick={handleSave}
            disabled={!dirty()}
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

function FormEditorSection(props: { title: string; subtitle?: string; icon: string; children: JSX.Element }) {
  return (
    <PanelDialog.Section title={props.title} subtitle={props.subtitle} icon={props.icon}>
      {props.children}
    </PanelDialog.Section>
  );
}
