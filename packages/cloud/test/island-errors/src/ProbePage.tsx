import Feed, { type FeedItem } from "./Feed.island";
import Ticker from "./Ticker.island";

const first: FeedItem[] = [{ id: "a", label: "revision 1" }];

/** Two feeds and the ticker that drives both, each its own island. */
export default function ProbePage() {
  return (
    <main style={{ padding: "1rem", display: "grid", gap: "1rem" }}>
      <Ticker />
      <Feed feed="steady" items={first} />
      <Feed feed="flaky" items={first} />
    </main>
  );
}
