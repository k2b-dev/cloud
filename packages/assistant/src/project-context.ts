import { type AiProjectFile, type AiProjectKnowledge, type AiProjectReference, aiProjects, aiSkills } from "@k2b/cloud/ai";
import { artifacts, type ArtifactIdentity } from "./artifacts/service";

export type AssistantProjectContextSnapshot = {
  projectId: string;
  knowledge: AiProjectKnowledge[];
  files: AiProjectFile[];
  references: AiProjectReference[];
  skills: NonNullable<Awaited<ReturnType<typeof aiSkills.projectSkills>>>;
  apps: Awaited<ReturnType<typeof artifacts.projectApps>>;
};

export const loadAssistantProjectContextSnapshot = async (
  identity: ArtifactIdentity,
  projectId: string,
): Promise<AssistantProjectContextSnapshot | null> => {
  const subject = identity.accessSubject;
  const project = await aiProjects.getByShortId(projectId, subject);
  if (!project) return null;
  const [knowledge, files, references, apps, skills] = await Promise.all([
    aiProjects.listKnowledge(project.id, subject),
    aiProjects.listFiles(project.id, subject),
    aiProjects.listReferences(project.id, subject),
    artifacts.projectApps(project.id, identity),
    aiSkills.projectSkills(project.id, subject),
  ]);
  return {
    projectId,
    apps,
    skills: skills ? { ...skills, items:skills.items.map(skill=>({...skill,id:skill.shortId})) } : { items:[],page:1,hasNext:false },
    knowledge: knowledge.map((item) => ({ ...item, id: item.shortId, projectId })),
    files: files.map((item) => ({ ...item, id: item.shortId, projectId })),
    references: references.map((item) => ({ ...item, id: item.shortId, projectId })),
  };
};
