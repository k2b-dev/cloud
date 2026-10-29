import { render } from "solid-js/web";
import { StudioPermissions } from "./StudioPermissions";

const entries = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    principal: { type: "user" as const, userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    permission: "admin" as const,
    displayName: "Alex Example",
    createdAt: "2026-10-23T12:00:00.000Z",
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    principal: { type: "service_account" as const, serviceAccountId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
    permission: "read" as const,
    displayName: "Invoice agent",
    serviceAccountKind: "agent" as const,
    createdAt: "2026-10-23T12:00:00.000Z",
  },
  {
    id: "33333333-3333-4333-8333-333333333333",
    principal: { type: "service_account" as const, serviceAccountId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" },
    permission: "read" as const,
    displayName: "Reporting service",
    serviceAccountKind: "standalone" as const,
    createdAt: "2026-10-23T12:00:00.000Z",
  },
];
render(
  () => (
    <main class="mx-auto flex max-w-2xl flex-col gap-4 p-4">
      <h1 class="text-xl font-semibold">Studio permissions</h1>
      <StudioPermissions
        artifactId="App234"
        entries={entries}
        loadProjects={async () => []}
        grant={async (principal, permission) => ({ id: crypto.randomUUID(), principal, permission, createdAt: "2026-10-23T12:00:00.000Z" })}
        change={async () => {}}
      />
    </main>
  ),
  document.getElementById("root")!,
);
