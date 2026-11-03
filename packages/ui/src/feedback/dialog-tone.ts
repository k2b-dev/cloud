import type { UiMessages } from "../intl/messages";

/** A dialog's outcome or risk: a 2 px edge in its colour inside the frame and its icon in the header. */
export type DialogTone = "success" | "warning" | "danger";

const tones = {
  success: { icon: "ti ti-circle-check", label: "dialogToneSuccess" },
  warning: { icon: "ti ti-alert-triangle", label: "dialogToneWarning" },
  danger: { icon: "ti ti-alert-octagon", label: "dialogToneDanger" },
} as const satisfies Record<DialogTone, { icon: string; label: keyof UiMessages }>;

/** The header icon of a toned dialog; it replaces the dialog's own icon. */
export const dialogToneIcon = (tone: DialogTone): string => tones[tone].icon;

/**
 * The tone's word for screen readers, so the tone is not carried by colour alone. Headers render it hidden with
 * `data-dialog-tone-label`; the dialog core makes it the dialog's description, and the heading keeps the title alone.
 */
export const dialogToneLabel = (messages: UiMessages, tone: DialogTone): string => messages[tones[tone].label];
