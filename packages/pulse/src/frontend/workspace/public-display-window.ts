type DisplayWindow = Pick<Window, "close" | "document"> & {
  opener: unknown;
  location: Pick<Location, "replace">;
};

/** Reserve the tab while the click still grants transient user activation. */
export const openResolvedPublicDisplay = async (
  resolveLink: () => Promise<string>,
  blockedMessage: string,
  reserve: () => DisplayWindow | null = () => window.open("about:blank", "_blank"),
): Promise<void> => {
  const display = reserve();
  if (!display) throw new Error(blockedMessage);
  try {
    display.opener = null;
    const referrer = display.document.createElement("meta");
    referrer.name = "referrer";
    referrer.content = "no-referrer";
    display.document.head.append(referrer);
    display.location.replace(await resolveLink());
  } catch (error) {
    display.close();
    throw error;
  }
};
