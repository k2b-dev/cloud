/**
 * Selection hook values for the color guide demo: what a host derives from an
 * app accent for light and dark mode. `scripts/color-guidance-docs.test.ts`
 * pins them to Cloud's derivation, so the demo shows the real app ink.
 */
type Hex = `#${string}`;
type HostFills = { ink: Hex; selected: Hex; selectedNav: Hex };
export type ColorDemoHost = { id: string; label: string; accent: Hex; light: HostFills; dark: HostFills };

export const colorDemoHosts: readonly ColorDemoHost[] = [
  {
    id: "teal",
    label: "Teal app",
    accent: "#14b8a6",
    light: { ink: "#0d7b6f", selected: "#effaf9", selectedNav: "#e8f8f6" },
    dark: { ink: "#14b8a6", selected: "#112c2e", selectedNav: "#123133" },
  },
  {
    id: "yellow",
    label: "Yellow app",
    accent: "#eab308",
    light: { ink: "#886805", selected: "#fefaee", selectedNav: "#fdf7e6" },
    dark: { ink: "#eab308", selected: "#2f2b18", selectedNav: "#363018" },
  },
];
