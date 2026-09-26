/**
 * The core `cloud-cli` skill, embedded in this `cld` build. `skills.ts` writes
 * it into every skill target together with the installed modules' references.
 * `skill-source.test.ts` keeps this list equal to `skills/cloud-cli`.
 */
import openai from "../../../skills/cloud-cli/agents/openai.yaml" with { type: "text" };
import plugins from "../../../skills/cloud-cli/references/plugins.md" with { type: "text" };
import signIn from "../../../skills/cloud-cli/references/sign-in.md" with { type: "text" };
import skill from "../../../skills/cloud-cli/SKILL.md" with { type: "text" };

export const CORE_SKILL_FILES: Readonly<Record<string, string>> = {
  "SKILL.md": skill,
  "agents/openai.yaml": openai,
  "references/plugins.md": plugins,
  "references/sign-in.md": signIn,
};
