import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import CodeApprovalReview from "../packages/core/src/pages/admin/code/CodeApprovalReview.island";

// The cross-package browser fixture belongs to the repository, never to the Cloud platform.
const root = document.createElement("main");
root.className = "scene scene--review-admin";
document.body.append(root);
render(
  () => (
    <LocaleProvider locale="de">
      <CodeApprovalReview
        codeId="c_review"
        versionId="11111111-1111-4111-8111-111111111111"
        number={5}
        title="Eingänge ordnen"
        viewerId="22222222-2222-4222-8222-222222222222"
        dateConfig={{ locale: "de", timeZone: "Europe/Berlin" }}
        tab="overview"
        authorUserId="33333333-3333-4333-8333-333333333333"
        recipient="Lea Muster"
        next="chat"
        binding={{
          codeId: "c_review",
          versionId: "11111111-1111-4111-8111-111111111111",
          sourceHash: "a".repeat(64),
          bundleHash: "b".repeat(64),
          manifestHash: "c".repeat(64),
          comparisonVersionId: null,
          comparisonSourceHash: null,
          comparisonBundleHash: null,
        }}
        status="pending"
        canApprove
        own={false}
        soleAdminNotice={null}
        staleComparison={false}
        newer={null}
        reason="Sie darf Aufgaben anlegen, die andere sehen."
        readModel={null}
        explanation="Sie ordnet neue Eingänge."
        activeVersion={4}
        comparison={null}
        files={[]}
        decision={null}
        previous={null}
        comments={[]}
        commentsNext={null}
        commentsTotal={0}
        listHref="/admin/code?sec=approvals"
        nextHref={null}
      />
    </LocaleProvider>
  ),
  root,
);
