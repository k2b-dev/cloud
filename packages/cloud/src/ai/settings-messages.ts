import { i18n } from "@k2b/stdlib";
import type { AiModelReferenceSetting, AiSettingsIssue } from "./settings";

type Reference = { setting: string; profile: string; next: string };

const catalog = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      notSaved: "The AI settings were not saved. Resolve the problems below and save again.",
      defaultModel: "default model",
      backgroundModel: "background model",
      workflowModel: "workflow model",
      visionModel: "Vision tool model",
      audioModel: "audio model",
      selectAnother: ({ setting }: { setting: string }) => `Select another ${setting}`,
      useDefaultModel: "use the default model instead",
      useBackgroundModel: "use the background model instead",
      disableVisionFallback: "disable the view_image fallback",
      disableAudio: "disable audio transcription",
      or: ({ first, second }: { first: string; second: string }) => `${first} or ${second}`,
      modelRequired: "Choose a default model while AI is enabled.",
      profileMissing: ({ setting, profile, next }: Reference) =>
        `The ${setting} still references “${profile}”. ${next} before removing this profile.`,
      profileDisabled: ({ setting, profile, next }: Reference) =>
        `The ${setting} uses “${profile}”, which is disabled. ${next}, or enable the profile again.`,
      noVision: ({ setting, profile, next }: Reference) => `“${profile}” does not support Vision, so it cannot be the ${setting}. ${next}.`,
      transcriptionOnly: ({ setting, profile, next }: Reference) =>
        `“${profile}” only transcribes audio, so it cannot be the ${setting}. ${next}.`,
      noTranscription: ({ setting, profile, next }: Reference) =>
        `“${profile}” does not transcribe audio, so it cannot be the ${setting}. ${next}.`,
      credentialMissing: ({ profile }: { profile: string }) =>
        `“${profile}” needs a provider API key. Enter the key in the profile or disable the profile.`,
    },
    de: {
      notSaved: "Die KI-Einstellungen wurden nicht gespeichert. Behebe die folgenden Probleme und speichere erneut.",
      defaultModel: "Standardmodell",
      backgroundModel: "Hintergrundmodell",
      workflowModel: "Workflow-Modell",
      visionModel: "Modell für das Bildwerkzeug",
      audioModel: "Audio-Modell",
      selectAnother: ({ setting }) => `Wähle ein anderes ${setting}`,
      useDefaultModel: "verwende stattdessen das Standardmodell",
      useBackgroundModel: "verwende stattdessen das Hintergrundmodell",
      disableVisionFallback: "deaktiviere den view_image-Fallback",
      disableAudio: "deaktiviere die Audio-Transkription",
      or: ({ first, second }) => `${first} oder ${second}`,
      modelRequired: "Wähle ein Standardmodell, solange KI aktiviert ist.",
      profileMissing: ({ setting, profile, next }) =>
        `Das ${setting} verweist noch auf „${profile}“. ${next}, bevor du dieses Profil entfernst.`,
      profileDisabled: ({ setting, profile, next }) =>
        `Das ${setting} verwendet „${profile}“, aber dieses Profil ist deaktiviert. ${next}. Du kannst das Profil auch wieder aktivieren.`,
      noVision: ({ setting, profile, next }) =>
        `„${profile}“ unterstützt keine Bildverarbeitung und kann nicht als ${setting} verwendet werden. ${next}.`,
      transcriptionOnly: ({ setting, profile, next }) =>
        `„${profile}“ transkribiert nur Audio und kann nicht als ${setting} verwendet werden. ${next}.`,
      noTranscription: ({ setting, profile, next }) =>
        `„${profile}“ transkribiert kein Audio und kann nicht als ${setting} verwendet werden. ${next}.`,
      credentialMissing: ({ profile }) =>
        `„${profile}“ benötigt einen API-Schlüssel des Anbieters. Gib den Schlüssel im Profil ein oder deaktiviere das Profil.`,
    },
  },
});

type Messages = ReturnType<typeof catalog.resolve>["t"];

const settingNoun = (t: Messages, setting: AiModelReferenceSetting): string =>
  ({
    "ai.default_model_id": t.defaultModel,
    "ai.background_model_id": t.backgroundModel,
    "ai.workflow_model_id": t.workflowModel,
    "ai.vision_model_id": t.visionModel,
    "ai.audio_model_id": t.audioModel,
  })[setting];

/** The way out that keeps the feature working without this profile, if the setting is optional. */
const alternative = (t: Messages, setting: AiModelReferenceSetting): string | undefined =>
  ({
    "ai.default_model_id": undefined,
    "ai.background_model_id": t.useDefaultModel,
    "ai.workflow_model_id": t.useBackgroundModel,
    "ai.vision_model_id": t.disableVisionFallback,
    "ai.audio_model_id": t.disableAudio,
  })[setting];

export type AiSettingsIssueWithMessage = AiSettingsIssue & { message: string };

/**
 * Turn validation issues into request-localized, actionable messages.
 *
 * `profiles` should list the prospective profiles first and the stored ones
 * after them, so a profile that is being removed still has its label. Only
 * ids and labels are read; provider keys never reach the messages.
 */
export const describeAiSettingsIssues = (
  issues: readonly AiSettingsIssue[],
  options: { locale?: string | null; profiles: ReadonlyArray<{ id: string; label: string }> },
): { issues: AiSettingsIssueWithMessage[]; errors: Record<string, string> } => {
  const t = catalog.resolve(options.locale ? [options.locale] : []).t;
  const labelOf = (profileId: string) => options.profiles.find((profile) => profile.id === profileId)?.label ?? profileId;

  const described = issues.map((issue): AiSettingsIssueWithMessage => {
    if (issue.code === "model_required") return { ...issue, message: t.modelRequired };
    const profile = labelOf(issue.profileId);
    if (issue.code === "provider_credential_missing") return { ...issue, message: t.credentialMissing({ profile }) };

    const setting = settingNoun(t, issue.setting);
    const other = alternative(t, issue.setting);
    const select = t.selectAnother({ setting });
    const reference = { setting, profile, next: other ? t.or({ first: select, second: other }) : select };
    if (issue.code === "model_profile_missing") return { ...issue, message: t.profileMissing(reference) };
    if (issue.code === "model_profile_disabled") return { ...issue, message: t.profileDisabled(reference) };
    const message =
      issue.setting === "ai.vision_model_id"
        ? t.noVision(reference)
        : issue.setting === "ai.audio_model_id"
          ? t.noTranscription(reference)
          : t.transcriptionOnly(reference);
    return { ...issue, message };
  });

  const errors: Record<string, string> = {};
  for (const issue of described)
    errors[issue.setting] = errors[issue.setting] ? `${errors[issue.setting]} ${issue.message}` : issue.message;
  return { issues: described, errors };
};

export const aiSettingsNotSavedMessage = (locale?: string | null): string => catalog.resolve(locale ? [locale] : []).t.notSaved;
export const checkAiSettingsMessages = () => catalog.check();
