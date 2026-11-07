/** A Space on the web, or Spaces itself without one. */
export const buildSpaceHref = (spaceId?: string): string => (spaceId ? `/app/spaces/${spaceId}` : "/app/spaces");

export const buildSpaceItemHref = (spaceId: string, itemId: string): string => `/app/spaces/${spaceId}?item=${itemId}`;

export const buildSpaceCalendarUid = (itemId: string): string => `${itemId}@spaces.cloud`;
