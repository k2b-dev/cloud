export const AI_PROJECT_FILE_MOUNT = "/project";
export const AI_SKILL_FILE_MOUNT = "/skills";

export const aiProjectFilePathFromMount = (path: string): string | null => {
  if (path === AI_PROJECT_FILE_MOUNT) return "";
  return path.startsWith(`${AI_PROJECT_FILE_MOUNT}/`) ? path.slice(AI_PROJECT_FILE_MOUNT.length + 1) : null;
};

export const mountAiProjectFilePath = (path: string): string => `${AI_PROJECT_FILE_MOUNT}/${path.replace(/^\/+/, "")}`;

export const aiSkillFilePathFromMount = (path: string): string | null => {
  if (path === AI_SKILL_FILE_MOUNT) return "";
  return path.startsWith(`${AI_SKILL_FILE_MOUNT}/`) ? path.slice(AI_SKILL_FILE_MOUNT.length + 1) : null;
};

export const mountAiSkillFilePath = (path: string): string => `${AI_SKILL_FILE_MOUNT}/${path.replace(/^\/+/, "")}`;
