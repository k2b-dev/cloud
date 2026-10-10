import { skill } from "@k2b/cloud";
import cloudNotebooksStructuredPages from "./skills/cloud-notebooks/references/structured-pages.md" with { type: "text" };
import cloudNotebooks from "./skills/cloud-notebooks/SKILL.md" with { type: "text" };

/** Assistant Skills this app ships; Cloud installs and updates them from these files. */
export const SKILLS = [
  skill({
    markdown: cloudNotebooks,
    references: {
      "references/structured-pages.md": cloudNotebooksStructuredPages,
    },
  }),
];
