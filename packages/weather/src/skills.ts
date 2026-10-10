import { skill } from "@k2b/cloud";
import cloudWeather from "./skills/cloud-weather/SKILL.md" with { type: "text" };

/** Assistant Skills this app ships; Cloud installs and updates them from these files. */
export const SKILLS = [skill({ markdown: cloudWeather })];
