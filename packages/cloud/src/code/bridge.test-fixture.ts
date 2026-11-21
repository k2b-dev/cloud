import { z } from "zod";

export const bridgeSkillReadQuery = {
  title: "Fixture",
  description: "Bridge fixture.",
  input: z.object({ id: z.string().describe("Skill ID returned by the fixture Skill list.") }).strict(),
  data: z.object({ value: z.string() }).strict(),
  openWorld: false,
  run: () => ({ ok: true as const, data: { data: { value: "done" } } }),
};
