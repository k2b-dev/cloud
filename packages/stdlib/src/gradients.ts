/**
 * A named gradient preset for the home page greeting.
 *
 * Each preset defines a CSS `background-image` (or plain color via `style`)
 * that is applied as an inline style to the user's name.
 *
 * @property id - Unique identifier used for persistence and lookup
 * @property label - Human-readable display name shown in settings
 * @property style - CSS inline style applied to the name `<span>` (may be empty for plain text)
 * @property preview - CSS `background-image` value rendered in settings swatches
 */
export type GradientPreset = {
  id: string;
  label: string;
  /** CSS applied as inline style to the name span */
  style: string;
  /** Preview gradient for the settings swatch */
  preview: string;
};

/**
 * All available gradient presets.
 *
 * Includes: Berry (default), Mono, Ocean, Sunset, Forest, Pride, and Gold.
 */
export const gradientPresets: GradientPreset[] = [
  {
    id: "default",
    label: "Berry",
    style:
      "background-image:linear-gradient(to right,#8b5cf6,#d946ef,#ec4899);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;color:transparent",
    preview: "linear-gradient(to right,#8b5cf6,#d946ef,#ec4899)",
  },
  {
    id: "mono",
    label: "Mono",
    style: "",
    preview: "linear-gradient(to right,#a1a1aa,#71717a)",
  },
  {
    id: "ocean",
    label: "Ocean",
    style:
      "background-image:linear-gradient(to right,#3b82f6,#06b6d4,#14b8a6);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;color:transparent",
    preview: "linear-gradient(to right,#3b82f6,#06b6d4,#14b8a6)",
  },
  {
    id: "sunset",
    label: "Sunset",
    style:
      "background-image:linear-gradient(to right,#f97316,#ef4444,#ec4899);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;color:transparent",
    preview: "linear-gradient(to right,#f97316,#ef4444,#ec4899)",
  },
  {
    id: "forest",
    label: "Forest",
    style:
      "background-image:linear-gradient(to right,#22c55e,#10b981,#14b8a6);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;color:transparent",
    preview: "linear-gradient(to right,#22c55e,#10b981,#14b8a6)",
  },
  {
    id: "pride",
    label: "Pride",
    style:
      "background-image:linear-gradient(to right,#ef4444,#f97316,#eab308,#22c55e,#3b82f6,#8b5cf6);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;color:transparent",
    preview: "linear-gradient(to right,#ef4444,#f97316,#eab308,#22c55e,#3b82f6,#8b5cf6)",
  },
  {
    id: "gold",
    label: "Gold",
    style:
      "background-image:linear-gradient(to right,#f59e0b,#d97706,#b45309);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;color:transparent",
    preview: "linear-gradient(to right,#f59e0b,#d97706,#b45309)",
  },
];

/**
 * The default gradient preset (`"Berry"`), used as a fallback when a
 * requested preset ID is not found.
 */
export const defaultGradient = gradientPresets[0]!;

/**
 * Looks up a gradient preset by its unique ID.
 *
 * Returns the {@link defaultGradient} (`"Berry"`) when no preset matches
 * the given ID.
 *
 * @param id - The preset ID to look up
 * @returns The matching preset, or the default if not found
 */
export const getGradientById = (id: string): GradientPreset =>
  gradientPresets.find((g) => g.id === id) ?? defaultGradient;

export const gradients = {
  gradientPresets,
  defaultGradient,
  getGradientById,
  presets: gradientPresets,
  getById: getGradientById,
} as const;
