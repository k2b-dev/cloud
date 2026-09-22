import { describe, expect, test } from "bun:test";
import type { AiModelReferenceSetting, AiSettingsIssue } from "./settings";
import { aiSettingsNotSavedMessage, checkAiSettingsMessages, describeAiSettingsIssues } from "./settings-messages";

const profiles = [
  { id: "tensorx", label: "TensorX Standard", apiKey: "sk-secret-never-shown" },
  { id: "cortecs", label: "Cortecs" },
];

const describeOne = (issue: AiSettingsIssue, locale = "en") => describeAiSettingsIssues([issue], { locale, profiles }).issues[0]?.message;

describe("AI settings issue messages", () => {
  test("keeps EN and DE complete", () => {
    expect(checkAiSettingsMessages()).toEqual([]);
    expect(aiSettingsNotSavedMessage("de-DE")).toStartWith("Die KI-Einstellungen wurden nicht gespeichert.");
  });

  test("names the blocking setting, the profile label, and the next step for a removed Vision model", () => {
    const issue = { code: "model_profile_missing", setting: "ai.vision_model_id", profileId: "tensorx" } as const;
    const described = describeAiSettingsIssues([issue], { locale: "en", profiles });

    expect(described.issues).toEqual([
      {
        ...issue,
        message:
          "The Vision tool model still references “TensorX Standard”. Select another Vision tool model or disable the view_image fallback before removing this profile.",
      },
    ]);
    expect(described.errors).toEqual({ "ai.vision_model_id": described.issues[0]!.message });
    expect(describeOne(issue, "de")).toBe(
      "Das Modell für das Bildwerkzeug verweist noch auf „TensorX Standard“. Wähle ein anderes Modell für das Bildwerkzeug oder deaktiviere den view_image-Fallback, bevor du dieses Profil entfernst.",
    );
  });

  test("covers every reference setting and reason", () => {
    const missing = (setting: AiModelReferenceSetting) => describeOne({ code: "model_profile_missing", setting, profileId: "tensorx" });
    expect(missing("ai.default_model_id")).toBe(
      "The default model still references “TensorX Standard”. Select another default model before removing this profile.",
    );
    expect(missing("ai.background_model_id")).toContain("Select another background model or use the default model instead");
    expect(missing("ai.workflow_model_id")).toContain("Select another workflow model or use the background model instead");
    expect(missing("ai.audio_model_id")).toContain("Select another audio model or disable audio transcription");

    expect(describeOne({ code: "model_required", setting: "ai.default_model_id" })).toBe("Choose a default model while AI is enabled.");
    expect(describeOne({ code: "model_profile_disabled", setting: "ai.background_model_id", profileId: "cortecs" })).toBe(
      "The background model uses “Cortecs”, which is disabled. Select another background model or use the default model instead, or enable the profile again.",
    );
    expect(describeOne({ code: "model_profile_incompatible", setting: "ai.vision_model_id", profileId: "cortecs" })).toStartWith(
      "“Cortecs” does not support Vision",
    );
    expect(describeOne({ code: "model_profile_incompatible", setting: "ai.audio_model_id", profileId: "cortecs" })).toStartWith(
      "“Cortecs” does not transcribe audio",
    );
    expect(describeOne({ code: "model_profile_incompatible", setting: "ai.workflow_model_id", profileId: "cortecs" })).toStartWith(
      "“Cortecs” only transcribes audio",
    );
    expect(describeOne({ code: "model_profile_missing", setting: "ai.vision_model_id", profileId: "unknown-id" })).toContain(
      "“unknown-id”",
    );
  });

  test("lists every profile without a provider key under the profiles setting and never includes keys", () => {
    const described = describeAiSettingsIssues(
      [
        { code: "provider_credential_missing", setting: "ai.model_profiles_json", profileId: "tensorx" },
        { code: "provider_credential_missing", setting: "ai.model_profiles_json", profileId: "cortecs" },
      ],
      { locale: "en", profiles },
    );

    expect(described.issues.map((issue) => ("profileId" in issue ? issue.profileId : null))).toEqual(["tensorx", "cortecs"]);
    expect(described.errors["ai.model_profiles_json"]).toBe(
      "“TensorX Standard” needs a provider API key. Enter the key in the profile or disable the profile. “Cortecs” needs a provider API key. Enter the key in the profile or disable the profile.",
    );
    expect(JSON.stringify(described)).not.toContain("sk-secret");
  });
});
