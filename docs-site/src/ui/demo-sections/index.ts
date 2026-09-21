import type { UiCatalogSectionId } from "../catalog";
import type { DemoSection } from "./types";

export const demoSectionLoaders: Record<UiCatalogSectionId, () => Promise<{ default: DemoSection }>> = {
  ai: () => import("./ai"),
  input: () => import("./input"),
  actions: () => import("./actions"),
  layout: () => import("./layout"),
  surfaces: () => import("./surfaces"),
  feedback: () => import("./feedback"),
  content: () => import("./content"),
  widgets: () => import("./widgets"),
  cloud: () => import("./cloud"),
};
