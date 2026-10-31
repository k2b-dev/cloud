import { accessMessages } from "./messages";
import type { AllowedLevel } from "./PermissionEditor";

/**
 * Rights-editor settings for sharing a Code itself (modell 7): `read` is Reader, `write` is Editor.
 * Only people and groups can be added; Code accounts, service accounts and audiences never appear.
 * Spread into `PermissionEditor`.
 */
export const codeSharing = (
  locale: string | null | undefined,
): { allowedLevels: AllowedLevel[]; allowServiceAccounts: false; allowAuthenticated: false; allowPublic: false } => {
  const { t } = accessMessages.resolve([locale ?? "en"]);
  return {
    allowedLevels: [
      { level: "read", label: t.codeReader, icon: "ti-eye", description: t.codeReaderDescription },
      { level: "write", label: t.codeEditor, icon: "ti-pencil", description: t.codeEditorDescription },
    ],
    allowServiceAccounts: false,
    allowAuthenticated: false,
    allowPublic: false,
  };
};
