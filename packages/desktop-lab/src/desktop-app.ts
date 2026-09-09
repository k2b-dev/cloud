import { defineDesktopApp } from "@k2b/cloud/desktop";

export const desktopApp = defineDesktopApp({
  name: "Markdown Desk",
  identifier: "dev.stuve.cloud.desktop-lab",
  version: "0.0.0",
  routing: "path",
  window: {
    width: 1100,
    height: 760,
    titleBar: "hidden-inset",
  },
  menu: [
    {
      label: "File",
      items: [
        { label: "Open File Dialog", action: "native:open-file" },
        { label: "Open Cloud Docs", action: "native:open-docs" },
        { type: "divider" },
        { role: "close" },
      ],
    },
    {
      label: "Native",
      items: [
        { label: "Message Box", action: "native:message" },
        { label: "Notification", action: "native:notification" },
        { label: "Context Menu", action: "native:context-menu" },
      ],
    },
  ],
});
