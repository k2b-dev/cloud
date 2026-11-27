/** Invented skills and projects for the AI area's browser fixture (Skills, Projects). */
import type { AiProjectsData, AiSkillsData } from "./content-data";
import type { AiFixtureApi, AiFixtureInput } from "./fixture-types";

export const skillsFixture = (_input: AiFixtureInput): AiSkillsData => ({
  skills: [],
  summary: { total: 0, unmanaged: 0, totalAccess: 0 },
  appSkillIssues: [],
  appNames: {},
  total: 0,
  page: 1,
  perPage: 100,
  search: "",
});

export const projectsFixture = (_input: AiFixtureInput): AiProjectsData => ({
  projects: [],
  summary: { total: 0, unmanaged: 0, totalAccess: 0 },
  total: 0,
  page: 1,
  perPage: 100,
  search: "",
});

export const contentApi: AiFixtureApi = () => undefined;
