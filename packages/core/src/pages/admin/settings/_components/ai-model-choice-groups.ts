export const AI_MODEL_CHOICE_GROUPS = [
  { value: "hosted", label: "Hosted" },
  { value: "private", label: "Private" },
  { value: "vision", label: "Vision" },
  { value: "tools", label: "Tools" },
] as const;

type ModelChoiceTraits = {
  dataBoundary: "hosted" | "private";
  capabilities: readonly string[];
};

export const aiModelChoiceGroups = (profile: ModelChoiceTraits): readonly string[] => [
  profile.dataBoundary,
  ...(profile.capabilities.includes("vision") ? ["vision"] : []),
  ...(profile.capabilities.includes("tools") ? ["tools"] : []),
];

export const aiModelGroupFiltersFor = (
  profiles: readonly ModelChoiceTraits[],
  labels?: Partial<Record<(typeof AI_MODEL_CHOICE_GROUPS)[number]["value"], string>>,
) => {
  const available = new Set(profiles.flatMap(aiModelChoiceGroups));
  return AI_MODEL_CHOICE_GROUPS.filter((group) => available.has(group.value)).map((group) => ({
    ...group,
    label: labels?.[group.value] ?? group.label,
  }));
};
