import { LocaleProvider } from "@k2b/ui";
import { WorkflowMachineAuthority } from "../../../src/frontend/_components/workflows/WorkflowMachineAuthority";

export default function MachineAuthorityFixture() {
  return (
    <LocaleProvider locale="en">
      <main class="mx-auto max-w-2xl p-4">
        <h1 class="mb-6 text-xl font-semibold">Inventory workflow</h1>
        <WorkflowMachineAuthority workflowId="INVENT1" />
      </main>
    </LocaleProvider>
  );
}
