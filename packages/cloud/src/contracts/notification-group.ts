/** App-chosen keys stay separate from the namespaced tags sent to browsers. */
export const isNotificationGroup = (value: unknown): value is string =>
  typeof value === "string" && value.length >= 1 && value.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(value);

export const notificationGroupTag = (appId: string, group: string): string | null =>
  typeof appId === "string" && /^[a-z][a-z0-9-]*$/.test(appId) && isNotificationGroup(group) ? `${appId}:${group}` : null;
