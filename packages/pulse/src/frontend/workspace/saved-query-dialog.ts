import { prompts } from "@k2b/ui";
import type { PulseExplorerQuery } from "../../contracts";
import { defaultSavedQueryName, normalizeSavedQueryDialogResult, type SavedQueryDialogResult } from "./saved-query-dialog-model";
import { usePulseMessages } from "../use-messages";

export const openSaveQueryDialog = async (compiled: PulseExplorerQuery | null): Promise<SavedQueryDialogResult | null> => {
  const t = usePulseMessages();
  const result = await prompts.form({
    title: t().saveQuery,
    icon: "ti ti-device-floppy",
    fields: {
      name: { type: "text", label: t().name, required: true, placeholder: defaultSavedQueryName(compiled, t()) },
      description: {
        type: "text",
        label: t().description,
        multiline: true,
        lines: 3,
        placeholder: t().queryNotesPlaceholder,
      },
    },
    confirmText: t().save,
  });
  return normalizeSavedQueryDialogResult(result);
};
