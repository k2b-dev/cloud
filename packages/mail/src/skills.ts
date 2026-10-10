import { skill } from "@k2b/cloud";
import cloudMail from "./skills/cloud-mail/SKILL.md" with { type: "text" };

/** Assistant Skills this app ships; Cloud installs and updates them from these files. */
export const SKILLS = [skill({ markdown: cloudMail })];
