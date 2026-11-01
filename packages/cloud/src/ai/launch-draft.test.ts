import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { person } from "../_internal/define-app.test-fixture";
import type { RequestAuthority } from "../server";
import { AiCreateConversationInputSchema } from "./http";
import { AI_TURN_ATTACHMENT_MAX_ITEMS } from "./limits";
import { userResourceContext } from "./projects.test-fixture";
import { __aiRoutesTest } from "./routes";
import { aiSkills } from "./skills";

afterEach(() => mock.restore());
const subject = userResourceContext({ type: "user", userId: person.id });

for (const authority of [
  null,
  {
    actor: { kind: "user", user: person, sessionKind: "app" },
    accessSubject: subject.accessSubject,
    credentialKind: "session",
    scopes: [],
  } satisfies RequestAuthority,
]) {
  test(`launch resolves readable enabled Skills as removable resources, once (${authority ? "resolved authority" : "no authority"})`, async () => {
    const read = spyOn(aiSkills, "getByName").mockResolvedValue({ shortId: "Sk2345", name: "cloud-grids", enabled: true } as never);
    const load = spyOn(aiSkills, "loadForTurn");
    const result = await __aiRoutesTest.prepareLaunchDraft(
      { skills: ["cloud-grids", "cloud-grids"], allowedTools: ["load_skill"] },
      subject,
      authority,
    );
    expect(result).toEqual({
      ok: true,
      data: { content: [{ type: "resource", ref: { type: "core.ai.skill", id: "Sk2345" }, title: "cloud-grids", icon: "ti ti-sparkles" }] },
    });
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith("cloud-grids", subject, "read", authority);
    expect(load).not.toHaveBeenCalled();
  });
}

test("launch does not bypass tool scope, permissions, disabled state or combined attachment bounds", async () => {
  const read = spyOn(aiSkills, "getByName").mockResolvedValue(null);
  expect((await __aiRoutesTest.prepareLaunchDraft({ skills: ["cloud-grids"], allowedTools: [] }, subject)).ok).toBeFalse();
  expect(read).not.toHaveBeenCalled();
  expect((await __aiRoutesTest.prepareLaunchDraft({ skills: ["cloud-grids"] }, subject)).ok).toBeFalse();
  read.mockResolvedValue({ enabled: false } as never);
  expect((await __aiRoutesTest.prepareLaunchDraft({ skills: ["cloud-grids"] }, subject)).ok).toBeFalse();
  read.mockResolvedValue({ shortId: "Sk2345", name: "cloud-grids", enabled: true } as never);
  expect(
    (
      await __aiRoutesTest.prepareLaunchDraft(
        {
          skills: ["cloud-grids"],
          draft: {
            content: Array.from({ length: AI_TURN_ATTACHMENT_MAX_ITEMS }, () => ({
              type: "resource" as const,
              ref: { type: "grids.base", id: "Base23" },
            })),
          },
        },
        subject,
      )
    ).ok,
  ).toBeFalse();
  expect(AiCreateConversationInputSchema.safeParse({ skills: ["Not a skill"] }).success).toBeFalse();
});
