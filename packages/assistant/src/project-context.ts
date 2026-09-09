import { type AiProjectFile, type AiProjectKnowledge, type AiProjectReference, aiProjects } from "@k2b/cloud/ai";
import type { AccessSubject } from "@k2b/cloud/server";

export type AssistantProjectContextSnapshot = {
  projectId: string;
  knowledge: AiProjectKnowledge[];
  files: AiProjectFile[];
  references: AiProjectReference[];
};

export const loadAssistantProjectContextSnapshot = async (
  subject: AccessSubject,
  projectId: string,
): Promise<AssistantProjectContextSnapshot | null> => {
  const project = await aiProjects.getByShortId(projectId, subject);
  if (!project) return null;
  const [knowledge, files, references] = await Promise.all([
    aiProjects.listKnowledge(project.id, subject),
    aiProjects.listFiles(project.id, subject),
    aiProjects.listReferences(project.id, subject),
  ]);
  return {
    projectId,
    knowledge: knowledge.map((item) => ({ ...item, id: item.shortId, projectId })),
    files: files.map((item) => ({ ...item, id: item.shortId, projectId })),
    references: references.map((item) => ({ ...item, id: item.shortId, projectId })),
  };
};
