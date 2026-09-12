// Page-local lifecycle only. Other browser tabs own independent runs.
const runs = new Map<string, Set<() => Promise<void>>>();
export function registerLocalRun(userId: string, resourceId: string, stop: () => Promise<void>) {
  const key = JSON.stringify([userId, resourceId]);
  const entries = runs.get(key) ?? new Set<() => Promise<void>>();
  entries.add(stop);
  runs.set(key, entries);
  return () => {
    entries.delete(stop);
    if (!entries.size) runs.delete(key);
  };
}
export async function stopLocalRuns(userId: string, resourceId: string) {
  await Promise.all([...(runs.get(JSON.stringify([userId, resourceId])) ?? [])].map((stop) => stop()));
}
