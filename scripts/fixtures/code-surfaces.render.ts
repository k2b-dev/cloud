import { setSystemTime } from "bun:test";
/** The real Code surfaces, with deterministic fictional inputs. No snapshot strings stand in for a renderer. */

import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { createConfig } from "../../packages/ssr/src/index";
import { renderedText } from "./rendered-markup";

setSystemTime(new Date("2026-11-14T12:00:00.000Z"));
Bun.plugin(createConfig({ dev: true, rootDir: import.meta.dir }).plugin());
const [
  { LocaleProvider },
  { default: CodePage },
  { codePageFixture },
  { CodeAreaView },
  { codeAdminMessages },
  { parseCodeAreaQuery },
  admin,
  { AiTurnBlockView },
  { codeReadModelFixture },
  { default: VersionCard },
  { AssistantLiveProvider, createAssistantLiveHub },
] = await Promise.all([
  import("../../packages/ui/src/index"),
  import("../../packages/cloud/src/ssr/code-page/CodePage"),
  import("../../packages/cloud/src/ssr/code-page/code-page.fixture"),
  import("../../packages/core/src/pages/admin/code/view"),
  import("../../packages/core/src/pages/admin/code/messages"),
  import("../../packages/core/src/pages/admin/code/area"),
  import("../../packages/core/src/pages/admin/code/CodeArea.fixture-data"),
  import("../../packages/cloud/src/ai/ui"),
  import("../../packages/core/src/code/read-model/fixtures"),
  import("../../packages/assistant/src/frontend/AssistantCodeVersionCard"),
  import("../../packages/assistant/src/frontend/assistant-live"),
]);
const fixtures: { file: string; name: string; text: string }[] = [];
function collect(file: string, name: string, locale: string, render: Parameters<typeof renderToString>[0]) {
  const html = renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return render();
      },
    }),
  );
  // Only explicitly marked source fields are exempt. A whole review or tab container never is.
  const ordinary = new HTMLRewriter()
    .on('[data-code-source-region="admin-approval"], [data-code-source-region="code-tab"]', { element: (element) => element.remove() })
    .transform(html);
  fixtures.push({ file, name: `${locale}/${name}`, text: renderedText(ordinary, "\n") });
}
const pageStates: Parameters<typeof codePageFixture>[0][] = [
  "overview",
  "waiting",
  "approval",
  "refused",
  "refused-nolink",
  "refused-reader",
  "refused-unloaded",
  "refused-policy",
  "refused-approval",
  "run-refused-policy",
  "paused",
  "runs",
  "run-failed",
  "run-rerun",
  "run-unclassified",
  "versions",
  "versions-failed",
  "waiting-unreadable",
  "internet",
  "no-internet",
  "internet-failed",
  "reader",
  "secrets",
  "secrets-empty",
  "secrets-error",
  "secrets-replaced",
  "secrets-submitted",
  "secrets-unsubmitted",
  "secrets-deleted",
  "activated",
  "empty",
  "no-access",
  "error",
];
for (const locale of ["de", "en"] as const) {
  collect("packages/assistant/src/frontend/AssistantCodeVersionCard.tsx", "chat/version-card", locale, () =>
    createComponent(AssistantLiveProvider, {
      value: createAssistantLiveHub(),
      get children() {
        return createComponent(VersionCard, {
          codeId: "c_fixture",
          versionId: "00000000-0000-4000-8000-000000000001",
          number: 5,
          timeZone: "Europe/Berlin",
        });
      },
    }),
  );
  for (const state of pageStates)
    collect("packages/cloud/src/ssr/code-page/CodePage.tsx", `page/${state}`, locale, () =>
      createComponent(CodePage, { data: codePageFixture(state, locale) }),
    );
  const queries: Record<string, string>[] = [
    {},
    { sec: "approvals" },
    { sec: "approvals", id: admin.FIXTURE_VERSIONS.rueckruf3 },
    { sec: "approvals", tab: "decided" },
    { sec: "code" },
    { sec: "code", id: "c_rechn" },
    { sec: "policy" },
    { sec: "groups" },
    { sec: "effective" },
    { sec: "history" },
    { sec: "cleanup" },
    { sec: "databases" },
    { sec: "limits" },
    { sec: "runners" },
  ];
  for (const state of admin.CODE_FIXTURE_STATES)
    for (const query of queries)
      collect("packages/core/src/pages/admin/code/view.tsx", `admin/${state}/${JSON.stringify(query)}`, locale, () =>
        createComponent(CodeAreaView, {
          t: codeAdminMessages.resolve([locale]).t,
          locale,
          dateConfig: { locale, timeZone: "Europe/Berlin" },
          query: parseCodeAreaQuery(query),
          data: state === "noperm" ? null : admin.codeFixtureData(state, query, locale),
          noPermission: state === "noperm",
          retryHref: "/admin/code",
          appNames: { mail: "Mail", spaces: "Spaces", werkstatt: "Werkstattbuch" },
        }),
      );
  for (const [name, result] of [
    [
      "code_check",
      {
        version: 1,
        result: {
          ok: false,
          diagnostics: [{ code: "code_unresolved_call", message: "Bad code.ts:19 sp_hidden", file: "code.ts", line: 19, column: 1 }],
        },
      },
    ],
    ["code_submit", { version: 1, codeId: "c_fixture", versionId: "00000000-0000-4000-8000-000000000001", number: 5, status: "pending" }],
  ] as const)
    collect("packages/cloud/src/ai/ui.tsx", `chat/${name}`, locale, () =>
      createComponent(AiTurnBlockView, {
        block: { id: "fixture", kind: "tool", callId: name, name, args: {}, status: "completed", result },
        turnId: "fixture",
      }),
    );
  // Consumer-independent data guard includes every final string; keys and authorized links stay transport-only.
  const model = codeReadModelFixture(locale);
  const strings = (value: unknown): string[] =>
    typeof value === "string"
      ? [value]
      : Array.isArray(value)
        ? value.flatMap(strings)
        : value && typeof value === "object"
          ? Object.entries(value).flatMap(([key, item]) =>
              ["versionId", "href", "submittedAt", "locale"].includes(key) ? [] : strings(item),
            )
          : [];
  fixtures.push({
    file: "packages/core/src/code/read-model/fixtures.ts",
    name: `${locale}/version-words`,
    text: strings(model).join("\n"),
  });
}
process.stdout.write(JSON.stringify(fixtures));
