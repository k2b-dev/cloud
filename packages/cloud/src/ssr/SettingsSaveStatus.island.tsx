import { SaveStatus } from "@k2b/ui";
import { settingsSaveControls } from "./settings-draft";

/** Status, Discard and Save in the head of a form level. Until the form registers, it shows "Saved" with both buttons disabled. */
export default function SettingsSaveStatus() {
  const controls = settingsSaveControls;
  return (
    <SaveStatus
      state={() => controls()?.state ?? "saved"}
      savedAt={() => controls()?.savedAt}
      invalidCount={() => controls()?.invalidCount ?? 1}
      onSave={() => controls()?.save()}
      onDiscard={() => controls()?.discard()}
    />
  );
}
