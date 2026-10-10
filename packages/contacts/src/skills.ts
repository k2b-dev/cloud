import { skill } from "@k2b/cloud";
import cloudContacts from "./skills/cloud-contacts/SKILL.md" with { type: "text" };

/** Assistant Skills this app ships; Cloud installs and updates them from these files. */
export const SKILLS = [skill({ markdown: cloudContacts })];
