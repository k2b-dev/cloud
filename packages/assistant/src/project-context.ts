import { type AiProjectFile, type AiProjectKnowledge, type AiProjectReference, aiProjects, aiSkills } from "@k2b/cloud/ai";
import type { RequestAuthority } from "@k2b/cloud/server";

export type AssistantProjectContextSnapshot = {
  projectId: string;
  knowledge: AiProjectKnowledge[];
  files: AiProjectFile[];
  references: AiProjectReference[];
  skills: NonNullable<Awaited<ReturnType<typeof aiSkills.projectSkills>>>;
  apps: {
    items: { id: string; title: string; icon: string; published: boolean; canManage: boolean; linked: boolean }[];
    page: number;
    hasNext: boolean;
  };
};

export const loadAssistantProjectContextSnapshot = async (
  identity: RequestAuthority,
  projectId: string,
): Promise<AssistantProjectContextSnapshot | null> => {
  const project = await aiProjects.getByShortId(projectId, identity);
  if (!project) return null;
  const [knowledge, files, references, skills] = await Promise.all([
    aiProjects.listKnowledge(project.id, identity),
    aiProjects.listFiles(project.id, identity),
    aiProjects.listReferences(project.id, identity),
    aiSkills.projectSkills(project.id, identity, { authority: identity }),
  ]);
  return {
    projectId,
    apps: { items: [], page: 1, hasNext: false },
    skills: skills
      ? { ...skills, items: skills.items.map((skill) => ({ ...skill, id: skill.shortId })) }
      : { items: [], page: 1, hasNext: false },
    knowledge: knowledge.map((item) => ({ ...item, id: item.shortId, projectId })),
    files: files.map((item) => ({ ...item, id: item.shortId, projectId })),
    references: references.map((item) => ({ ...item, id: item.shortId, projectId })),
  };
};
