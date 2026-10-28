import type { AiModelAssignment, AiModelSlot } from "../shared/ai-models";
import type { AiModelProfile, AiSettingsState } from "./types";

/** Fixed snapshots for tests; production reads the catalog. */
export const aiModelFixture = (overrides: Partial<AiModelProfile> = {}): AiModelProfile => ({
  id: "chat",
  modelId: "chat",
  providerId: "provider",
  label: "Chat",
  variantLabel: "Standard",
  description: "For everyday work",
  icon: { kind: "provider" },
  showInPicker: true,
  provider: "ollama",
  model: "chat",
  enabled: true,
  capabilities: ["tools"],
  dataBoundary: "private",
  ...overrides,
});
export const aiAssignmentFixture = (slot: AiModelSlot, variantId: string | null): AiModelAssignment => ({
  slot,
  variantId,
  revision: 1,
  updatedAt: "2026-10-16T00:00:00.000Z",
  updatedBy: null,
});
export const aiSettingsFixture = (overrides: Partial<AiSettingsState> = {}): AiSettingsState => ({
  ok: true,
  enabled: true,
  profiles: [aiModelFixture()],
  assignments: [aiAssignmentFixture("balanced", "chat")],
  globalInstructions: "",
  localClientInstructions: "",
  compactionInstructions: "",
  maxToolResultChars: 2_000_000,
  firecrawlConfigured: false,
  ...overrides,
});
