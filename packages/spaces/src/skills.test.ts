import { expect, test } from "bun:test";
import { SKILLS } from "./skills";

test("ships its Skills with every reference linked from the instructions", () => {
  expect(SKILLS.map((skill) => skill.name)).toEqual(["cloud-spaces"]);
  for (const skill of SKILLS)
    for (const reference of skill.references) expect(skill.instructions).toContain(`/skills/${skill.name}/${reference.path}`);
});

test("app skill retains domain and declared cross-app guidance", async () => {
  const skill = SKILLS[0]!;
  const instructions = [skill.instructions, ...skill.references.map((ref) => ref.content)].join("\n");
  for (const text of ["active blockers", "add the returned calendar attachment", "real prerequisites", "consider Contacts"])
    expect(instructions).toContain(text);
  const source = await Bun.file(new URL("./capabilities.ts", import.meta.url)).text();
  const declared = [...source.matchAll(/^    "([a-z0-9.-]+)": \{/gm)].map((match) => `spaces.${match[1]}`);
  for (const match of instructions.matchAll(/`(spaces\.[a-z0-9.-]+)`/g)) expect(declared).toContain(match[1]!);
});

test("Spaces skill retains calendar/mail handoff", () => {
  const spaces = SKILLS.find((skill) => skill.name === "cloud-spaces")!;
  for (const id of ["spaces.task.update", "spaces.event.update", "spaces.task.set-completed"]) {
    expect(spaces.instructions).toContain(id);
  }
  const calendar = spaces.references!.find((reference) => reference.path === "references/calendar-mail.md")!.content;
  expect(calendar).toContain("If the source is unavailable, stop");
  expect(calendar).toContain("UTF-8 bytes and then Base64");
  expect(calendar).toContain("mail.draft.create");
});

test("Spaces skill explains assignee previews and overdue tasks", () => {
  const spaces = SKILLS[0]!;
  expect(spaces?.instructions).toContain("spaces.template.list");
  expect(spaces?.instructions).toContain("Never guess a date from a vague request");
  expect(spaces?.instructions).toContain("at most three assignees and tags");
  expect(spaces?.instructions).toContain("relationsTruncated");
  expect(spaces?.instructions).toContain("assigneeCount");
  expect(spaces?.instructions).toContain("overdue");
  expect(spaces?.instructions).toContain("never infer it from `deadline` alone");
  expect(spaces?.instructions).toContain("is larger than the number of `assignees`");
  expect(spaces?.instructions).toContain("3 of 11");
});

test("main instructions stay compact", () => {
  expect(SKILLS[0]!.instructions.length).toBeLessThan(5000);
});
