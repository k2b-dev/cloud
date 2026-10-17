type SearchTopic = { id: string; title: string; description?: string };

/** Use server ranking for articles; metadata matches remain usable during loading or outages. */
export const searchHelpTopics = <T extends SearchTopic>(topics: readonly T[], query: string, remoteIds: readonly string[] | null): T[] => {
  if (remoteIds === null)
    return topics.filter((topic) => [topic.title, topic.description].some((part) => part?.toLocaleLowerCase().includes(query)));
  const byId = new Map(topics.map((topic) => [topic.id, topic]));
  return remoteIds.flatMap((id) => {
    const topic = byId.get(id);
    return topic ? [topic] : [];
  });
};
