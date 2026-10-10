import { skill } from "@k2b/cloud";
import cloudGridsQueryTasks from "./skills/cloud-grids/references/query-tasks.md" with { type: "text" };
import cloudGrids from "./skills/cloud-grids/SKILL.md" with { type: "text" };

/** Assistant Skills this app ships; Cloud installs and updates them from these files. */
export const SKILLS = [
  skill({
    markdown: cloudGrids,
    references: {
      "references/query-tasks.md": cloudGridsQueryTasks,
    },
  }),
];
