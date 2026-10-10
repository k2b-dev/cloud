import { skill } from "@k2b/cloud";
import cloudSpacesCalendarMail from "./skills/cloud-spaces/references/calendar-mail.md" with { type: "text" };
import cloudSpaces from "./skills/cloud-spaces/SKILL.md" with { type: "text" };

/** Assistant Skills this app ships; Cloud installs and updates them from these files. */
export const SKILLS = [
  skill({
    markdown: cloudSpaces,
    references: {
      "references/calendar-mail.md": cloudSpacesCalendarMail,
    },
  }),
];
