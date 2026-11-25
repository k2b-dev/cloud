import { Approvals } from "@k2b/cloud/approvals/ui";
import type { ApprovalPage } from "@k2b/cloud/contracts/approvals";
import { Canvas, Pane } from "@k2b/ui/v2";
import AccountWorkspace, { useAccountMessages } from "./AccountWorkspace";
import type { AccountUserView } from "./account-view";

/** `/me/approvals` on v2: every app's open approvals, or one app's with `?app=`. */
export default function ApprovalsScreen(props: { user: AccountUserView; appTab: boolean; app?: string; initial: ApprovalPage }) {
  const t = useAccountMessages();
  return (
    <AccountWorkspace user={props.user} active="approvals" appTab={props.appTab}>
      <Pane label={t().approvals}>
        {/* k2b-ui gap: the platform's approval list (`@k2b/cloud/approvals/ui`, shared by several apps) is still v1; it
            stands in a Canvas until a v2 list exists. */}
        <Canvas label={t().approvals}>
          <Approvals app={props.app} initial={props.initial} />
        </Canvas>
      </Pane>
    </AccountWorkspace>
  );
}
