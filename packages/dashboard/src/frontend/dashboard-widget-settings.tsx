import { openCloudResourcePicker } from "@k2b/cloud/browser/resource-picker";
import { WIDGET_SETTING_TEXT_MAX_LENGTH, type WidgetSettingField } from "@k2b/cloud/contracts";
import {
  BottomSheet,
  Button,
  bottomSheetOptions,
  dialogCore,
  IconButton,
  PanelDialog,
  panelDialogOptions,
  SegmentedControl,
  Select,
  Switch,
  TextInput,
} from "@k2b/ui";
import { createSignal, createUniqueId, For, Show } from "solid-js";
import {
  DASHBOARD_MAX_TITLE_LENGTH,
  type DashboardCatalogWidget,
  type DashboardEntrySettings,
  type DashboardEntrySettingValue,
} from "../shared";
import { DASHBOARD_PHONE_QUERY } from "./dashboard-gallery";
import { type DashboardMessages, dashboardMessages } from "./messages";

/** A choice with at most this many options shows them side by side; more open as a list. */
const SEGMENTED_MAX_OPTIONS = 3;

/** One declared setting as the control of its kind. `value` is what the person set, or `undefined` for "not set". */
const SettingField = (props: {
  field: WidgetSettingField;
  appId: string;
  appIcon: string;
  value: DashboardEntrySettingValue | undefined;
  onChange: (value: DashboardEntrySettingValue | undefined) => void;
  t: DashboardMessages;
}) => {
  const field = props.field;
  const text = () => (typeof props.value === "string" ? props.value : undefined);
  switch (field.kind) {
    case "choice": {
      // Without a choice of the person the widget uses its default, so the control shows it.
      const chosen = () => text() ?? field.default;
      if (field.options.length > SEGMENTED_MAX_OPTIONS)
        return (
          <Select
            label={field.label}
            value={() => chosen() ?? null}
            onValueChange={(value) => props.onChange(value ?? undefined)}
            options={field.options.map((option) => ({ id: option.value, label: option.label }))}
          />
        );
      const labelId = createUniqueId();
      return (
        <div class="dashboard-widget-settings__choice" role="group" aria-labelledby={labelId}>
          <span id={labelId} class="dashboard-widget-settings__label">
            {field.label}
          </span>
          <SegmentedControl
            ariaLabel={field.label}
            value={() => chosen() ?? ""}
            onValueChange={props.onChange}
            options={field.options.map((option) => ({ value: option.value, label: option.label }))}
          />
        </div>
      );
    }
    case "toggle":
      return (
        <Switch
          label={field.label}
          value={() => (typeof props.value === "boolean" ? props.value : (field.default ?? false))}
          onValueChange={props.onChange}
        />
      );
    case "text":
      return (
        <TextInput
          label={field.label}
          placeholder={field.placeholder}
          maxLength={field.maxLength ?? WIDGET_SETTING_TEXT_MAX_LENGTH}
          value={() => text() ?? ""}
          onValueChange={props.onChange}
        />
      );
    case "resource": {
      const chosen = () => (typeof props.value === "object" ? props.value : undefined);
      const choose = async () => {
        const item = await openCloudResourcePicker({
          title: field.label,
          initialAppId: props.appId,
          resourceType: field.type,
          requireReader: true,
        });
        // The title is only what this dialog shows; the widget gets the reference and authorizes it on every call.
        if (item?.ref.type === field.type)
          props.onChange({ type: item.ref.type, id: item.ref.id, title: item.title.slice(0, DASHBOARD_MAX_TITLE_LENGTH) });
      };
      return (
        <TextInput
          label={field.label}
          readOnly
          placeholder={props.t.resourceNone}
          value={() => (chosen() ? (chosen()?.title ?? props.t.resourceChosen) : "")}
          icon={props.appIcon}
          // A read-only input offers no clear button of its own, so the field brings one.
          suffix={
            <>
              <Show when={chosen()}>
                <IconButton size="sm" label={props.t.resourceClear({ label: field.label })} onClick={() => props.onChange(undefined)}>
                  <i class="ti ti-x" aria-hidden="true" />
                </IconButton>
              </Show>
              <Button variant="ghost" size="sm" onClick={() => void choose()}>
                {chosen() ? props.t.resourceChange : props.t.resourceChoose}
              </Button>
            </>
          }
        />
      );
    }
  }
};

/**
 * Asks for the settings of one widget on the board, in a form built from what the widget declares: a dialog or, on a
 * phone, a bottom sheet. Resolves with the values the person set, without the settings they left unset, or `undefined`
 * when they closed it. Nothing is saved here: the board saves with Done.
 */
export const openDashboardWidgetSettings = (
  props: { widget: DashboardCatalogWidget; settings: DashboardEntrySettings | undefined },
  locale: string,
): Promise<DashboardEntrySettings | undefined> => {
  const t = dashboardMessages.resolve([locale]).t;
  const title = t.customizeTitle({ name: props.widget.title });
  const subtitle = t.customizeSubtitle({ app: props.widget.appName });
  const fields = Object.entries(props.widget.settings ?? {});
  const phone = window.matchMedia(DASHBOARD_PHONE_QUERY).matches;
  return dialogCore.open<DashboardEntrySettings>(
    (close, context) => {
      const dismiss = () => void context.requestDismiss();
      const formId = createUniqueId();
      const [draft, setDraft] = createSignal<DashboardEntrySettings>({ ...props.settings });
      const set = (name: string, value: DashboardEntrySettingValue | undefined) =>
        setDraft(({ [name]: _previous, ...rest }) => (value === undefined ? rest : { ...rest, [name]: value }));
      const submit = () => {
        const settings: DashboardEntrySettings = {};
        for (const [name] of fields) {
          const value = draft()[name];
          const chosen = typeof value === "string" ? value.trim() : value;
          if (chosen !== undefined && chosen !== "") settings[name] = chosen;
        }
        close(settings);
      };
      const form = (
        <form
          id={formId}
          class="dashboard-widget-settings"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <For each={fields}>
            {([name, field]) => (
              <SettingField
                field={field}
                appId={props.widget.appId}
                appIcon={props.widget.appIcon}
                value={draft()[name]}
                onChange={(value) => set(name, value)}
                t={t}
              />
            )}
          </For>
        </form>
      );
      const footer = (
        <>
          <Button variant="ghost" class="dashboard-widget-settings__reset" onClick={() => setDraft({})}>
            <i class="ti ti-arrow-back-up" aria-hidden="true" />
            {t.reset}
          </Button>
          <div class="dashboard-widget-settings__actions">
            <Button variant="secondary" onClick={dismiss}>
              {t.cancel}
            </Button>
            <Button type="submit" form={formId}>
              {t.apply}
            </Button>
          </div>
        </>
      );
      return phone ? (
        <BottomSheet onDismiss={dismiss}>
          <BottomSheet.Header title={title} subtitle={subtitle} close={dismiss} />
          <BottomSheet.Body>{form}</BottomSheet.Body>
          <BottomSheet.Footer>{footer}</BottomSheet.Footer>
        </BottomSheet>
      ) : (
        <PanelDialog>
          <PanelDialog.Header title={title} subtitle={subtitle} close={dismiss} />
          <PanelDialog.Body>{form}</PanelDialog.Body>
          <PanelDialog.Footer>{footer}</PanelDialog.Footer>
        </PanelDialog>
      );
    },
    { ...(phone ? bottomSheetOptions : panelDialogOptions), history: true, ariaLabel: title },
  );
};
