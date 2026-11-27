import { aiAppSkills, aiProjects, aiSkills } from "@k2b/cloud/ai";
import { formatDateTime } from "@k2b/cloud/shared";
import type { AiPageInput } from "./page-input";

const PER_PAGE = 100;

const listQuery = (input: AiPageInput) => {
  const search = (input.query.search ?? "").trim();
  const requested = Number.parseInt(input.query.page ?? "1", 10);
  return { search, page: Number.isFinite(requested) && requested > 0 ? requested : 1 };
};

/** Times worded by the server in the viewer's zone, so the server's picture and the island's agree. */
const worded = (input: AiPageInput) => (iso: string) => formatDateTime(iso, input.dates);

/**
 * Shared skills, one page of them with the summary, and the app skills Cloud does not offer. `skill` in the address
 * opens one of the page's skills beside the list.
 */
export const loadAiSkills = async (input: AiPageInput) => {
  const { search, page } = listQuery(input);
  const [list, summary, appSkillIssues] = await Promise.all([
    aiSkills.admin.list({ search: search || undefined, page, perPage: PER_PAGE }),
    aiSkills.admin.summary({ search: search || undefined }),
    aiAppSkills.appSkillIssues(),
  ]);
  const word = worded(input);
  const skills = list.items.map((skill) => ({ ...skill, updated: word(skill.updatedAt), created: word(skill.createdAt) }));
  const open = input.query.skill ?? null;
  return {
    skills,
    summary,
    appSkillIssues,
    appNames: input.appNames,
    total: list.total,
    page: list.page,
    perPage: list.perPage,
    search,
    open: skills.some((skill) => skill.shortId === open) ? open : null,
  };
};

/** Shared projects, one page of them with the summary; `project` in the address opens one of them beside the list. */
export const loadAiProjects = async (input: AiPageInput) => {
  const { search, page } = listQuery(input);
  const [list, summary] = await Promise.all([
    aiProjects.admin.list({ search: search || undefined, page, perPage: PER_PAGE }),
    aiProjects.admin.summary({ search: search || undefined }),
  ]);
  const word = worded(input);
  const projects = list.items.map((project) => ({ ...project, updated: word(project.updatedAt), created: word(project.createdAt) }));
  const open = input.query.project ?? null;
  return {
    projects,
    summary,
    total: list.total,
    page: list.page,
    perPage: list.perPage,
    search,
    open: projects.some((project) => project.shortId === open) ? open : null,
  };
};

export type AiSkillsData = Awaited<ReturnType<typeof loadAiSkills>>;
export type AiProjectsData = Awaited<ReturnType<typeof loadAiProjects>>;
export type AiSkillRow = AiSkillsData["skills"][number];
export type AiProjectRow = AiProjectsData["projects"][number];
