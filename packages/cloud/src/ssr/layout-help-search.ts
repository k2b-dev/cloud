type SearchTopic = { id: string; title: string; description?: string; kind: "document" | "content" };

/** Use server ranking for documents; metadata remains usable during loading or outages. */
export const searchHelpTopics = <T extends SearchTopic>(topics: readonly T[], query: string, remoteIds: readonly string[] | null): T[] => {
  const local = topics.filter((topic) => [topic.title, topic.description].some((part) => part?.toLocaleLowerCase().includes(query)));
  if (remoteIds === null) return local;
  const documents = new Map(topics.filter((topic) => topic.kind === "document").map((topic) => [topic.id, topic]));
  return [
    ...remoteIds.flatMap((id) => {
      const topic = documents.get(id);
      return topic ? [topic] : [];
    }),
    ...local.filter((topic) => topic.kind === "content"),
  ];
};
