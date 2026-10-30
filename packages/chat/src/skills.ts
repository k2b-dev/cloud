import { skill } from "@k2b/cloud";
import cloudChat from "./skills/cloud-chat/SKILL.md" with { type: "text" };

export const SKILLS = [skill({ markdown: cloudChat })];
