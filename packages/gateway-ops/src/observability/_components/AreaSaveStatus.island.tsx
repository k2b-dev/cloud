import { SaveStatus } from "@k2b/ui";
import { areaSaveControls } from "./save-controls";

/** Status, Discard and Save in the head of a form level. Until the form registers, it shows "Saved" with both buttons disabled. */
export default function AreaSaveStatus() {
  const controls = areaSaveControls;
  return (
    <SaveStatus
      state={() => controls()?.state ?? "saved"}
      savedAt={() => controls()?.savedAt}
      invalidCount={() => controls()?.invalidCount ?? 1}
      saveDisabled={() => controls()?.saveDisabled === true}
      onSave={() => controls()?.save()}
      onDiscard={() => controls()?.discard()}
    />
  );
}
