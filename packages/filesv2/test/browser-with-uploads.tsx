import type { ComponentProps } from "solid-js";

type BrowserComponent = typeof import("../src/frontend/Browser").default;

/**
 * Browser as the workspace mounts it: inside an `AppWorkspace`, whose head it fills (path, search, view, New), with an
 * upload queue of its own. Import after the test's module mocks.
 */
export async function browserWithUploads() {
  const { default: Browser } = await import("../src/frontend/Browser");
  const { createFilesUploads } = await import("../src/frontend/files-uploads");
  const { AppWorkspace } = await import("@k2b/ui");
  return (props: Omit<ComponentProps<BrowserComponent>, "uploads">) => {
    const uploads = createFilesUploads();
    return (
      <AppWorkspace>
        <Browser {...props} uploads={uploads} />
      </AppWorkspace>
    );
  };
}
