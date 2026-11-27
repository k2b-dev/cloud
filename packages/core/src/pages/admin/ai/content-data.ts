import { aiAppSkills, aiProjects, aiSkills } from "@k2b/cloud/ai";
import type { AiPageInput } from "./page-input";

const PER_PAGE = 100;

const listQuery = (input: AiPageInput) => {
  const search = (input.query.search ?? "").trim();
  const requested = Number.parseInt(input.query.page ?? "1", 10);
  return { search, page: Number.isFinite(requested) ? requested : 1 };
};

/** Shared skills, one page of them with the summary, and the app skills Cloud does not offer. */
export const loadAiSkills = async (input: AiPageInput) => {
  const { search, page } = listQuery(input);
  const [list, summary, appSkillIssues] = await Promise.all([
    aiSkills.admin.list({ search: search || undefined, page, perPage: PER_PAGE }),
    aiSkills.admin.summary({ search: search || undefined }),
    aiAppSkills.appSkillIssues(),
  ]);
  return {
    skills: list.items,
    summary,
    appSkillIssues,
    appNames: input.appNames,
    total: list.total,
    page: list.page,
    perPage: list.perPage,
    search,
  };
};

/** Shared projects, one page of them with the summary. */
export const loadAiProjects = async (input: AiPageInput) => {
  const { search, page } = listQuery(input);
  const [list, summary] = await Promise.all([
    aiProjects.admin.list({ search: search || undefined, page, perPage: PER_PAGE }),
    aiProjects.admin.summary({ search: search || undefined }),
  ]);
  return { projects: list.items, summary, total: list.total, page: list.page, perPage: list.perPage, search };
};

export type AiSkillsData = Awaited<ReturnType<typeof loadAiSkills>>;
export type AiProjectsData = Awaited<ReturnType<typeof loadAiProjects>>;
