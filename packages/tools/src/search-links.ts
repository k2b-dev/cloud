import { resolveRegistry } from "./frontend/tools/registry";

const english = resolveRegistry("en");
const german = resolveRegistry("de");

// Reuse the same catalog as the overview and local tool search.
export const toolSearchLinks = english.tools.map((tool) => ({
  label: tool.name,
  description: tool.description,
  href: `/tools/${tool.id}`,
  icon: tool.icon,
  keywords: [english.searchText(tool), german.searchText(german.toolById(tool.id)!)],
}));

export const germanToolSearchLabels = Object.fromEntries(german.tools.map((tool) => [`/tools/${tool.id}`, tool.name]));
export const germanToolSearchDescriptions = Object.fromEntries(german.tools.map((tool) => [`/tools/${tool.id}`, tool.description]));
