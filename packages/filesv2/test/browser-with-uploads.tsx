import type { ComponentProps } from "solid-js";

type BrowserComponent = typeof import("../src/frontend/Browser").default;

/** Browser as the workspace mounts it, with an upload queue of its own. Import after the test's module mocks. */
export async function browserWithUploads() {
  const { default: Browser } = await import("../src/frontend/Browser");
  const { createFilesUploads } = await import("../src/frontend/files-uploads");
  return (props: Omit<ComponentProps<BrowserComponent>, "uploads">) => {
    const uploads = createFilesUploads();
    return <Browser {...props} uploads={uploads} />;
  };
}
