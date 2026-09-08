import { IconInput, NoticeCard, PanelDialog, SettingsGroup, SettingsModal, TextInput } from "@k2b/ui";
import type { JSX } from "solid-js";
import type { CustomAppDefinition } from "../../../custom-apps/contracts";
import { ScopedPermissionEditor } from "../permissions/ScopedPermissionEditor";
import { type CustomAppBuilderText, useCustomAppBuilderMessages } from "./builder-messages";

export function CustomAppSettings(props: {
  appId: string;
  definition: CustomAppDefinition;
  onNameChange: (name: string) => void;
  onIconChange: (icon: string | undefined) => void;
  onClose: () => void;
  status: string;
  error: boolean;
  lifecycle: JSX.Element;
  defaultTab?: "general" | "access" | "lifecycle";
}) {
  const messages = useCustomAppBuilderMessages();
  const text = (value: CustomAppBuilderText) => messages().text({ value });
  const SaveStatus = () => (
    <NoticeCard class="mt-6" tone={props.error ? "danger" : "neutral"} role={props.error ? "alert" : "status"}>
      {props.status}
    </NoticeCard>
  );
  return (
    <PanelDialog>
      <SettingsModal title={text("App settings")} defaultTab={props.defaultTab} onClose={props.onClose}>
        <SettingsModal.Tab id="general" title={text("General")} icon="ti ti-id">
          <SettingsGroup title={text("Identity")}>
            <TextInput label={text("Name")} value={() => props.definition.name} onValueChange={props.onNameChange} required />
            <IconInput
              label={text("Icon")}
              value={() => (props.definition.icon ? `ti ti-${props.definition.icon}` : null)}
              onValueChange={(value) => props.onIconChange(value?.replace(/^ti ti-/, "") || undefined)}
              clearable
            />
          </SettingsGroup>
          <SaveStatus />
        </SettingsModal.Tab>
        <SettingsModal.Tab id="access" title={text("Access")} icon="ti ti-shield">
          <SettingsGroup title={text("Who can open the published app")}>
            <NoticeCard tone="info">
              <p>{text("App grants are separate from Base access. Choose users, groups, all signed-in users, or public access.")}</p>
              <p class="mt-2">
                {text("App access never opens the raw Base, Record API, or GQL. Availability rules can only restrict this access further.")}
              </p>
              <p class="mt-2">
                {text("Forms and workflow actions allow only what you publish. Workflow actions require a signed-in user.")}
              </p>
            </NoticeCard>
            <ScopedPermissionEditor scope={{ type: "customApp", id: props.appId }} canEdit />
          </SettingsGroup>
          <SaveStatus />
        </SettingsModal.Tab>
        <SettingsModal.Tab id="lifecycle" title={text("Lifecycle")} icon="ti ti-alert-triangle" tone="danger">
          <SettingsGroup
            title={text("Danger zone")}
            description={text("Take the live app offline or permanently remove it. Base data is not deleted.")}
          >
            {props.lifecycle}
          </SettingsGroup>
          <SaveStatus />
        </SettingsModal.Tab>
      </SettingsModal>
    </PanelDialog>
  );
}
