type Timer = ReturnType<typeof setTimeout> | number;
export const seenRange = (
  items: readonly { seq?: number; kind: "text" | "system"; own: boolean }[],
  firstIndex: number,
  lastIndex: number,
) => {
  if (firstIndex < 0 || lastIndex < firstIndex || lastIndex >= items.length) return null;
  // System and own messages do not count as unread, even when the marker leaves them above the view.
  while (firstIndex > 0) {
    const previous = items[firstIndex - 1]!;
    if (previous.seq !== undefined && previous.kind !== "system" && !previous.own) break;
    firstIndex--;
  }
  const seqs = items.slice(firstIndex, lastIndex + 1).flatMap((item) => (item.seq === undefined ? [] : [item.seq]));
  return seqs.length ? { first: seqs[0]!, last: seqs.at(-1)! } : null;
};
type Timers = {
  setTimeout(callback: () => void, delay: number): Timer;
  clearTimeout(timer: Timer): void;
  now(): number;
};
export const createReadReporter = (options: {
  start: number;
  post(seq: number): Promise<unknown>;
  active(): boolean;
  onGap?(from: number | null): void;
  timers?: Timers;
}) => {
  const timers: Timers = options.timers ?? {
    setTimeout: (callback, delay) => setTimeout(callback, delay),
    clearTimeout: (timer) => clearTimeout(timer),
    now: Date.now,
  };
  let start = options.start;
  let frontier = start;
  let posted = start;
  let sent = start;
  let range: { first: number; last: number } | null = null;
  let lastPost = -Infinity;
  let timer: Timer | undefined;
  let disposed = false;
  let generation = 0;
  const inFlight = new Set<Promise<void>>();
  const flush = () => {
    if (frontier <= posted || frontier <= sent) return;
    const seq = frontier;
    sent = seq;
    const epoch = generation;
    lastPost = timers.now();
    // In-flight responses from before a mark-unread cannot erase its new frontier.
    const post = options
      .post(seq)
      .then(() => {
        if (epoch === generation) posted = Math.max(posted, seq);
      })
      .catch(() => {
        if (epoch === generation && sent === seq) sent = posted;
      });
    inFlight.add(post);
    void post.then(() => inFlight.delete(post));
  };
  const schedule = () => {
    if (disposed || frontier <= posted || timer !== undefined) return;
    const wait = Math.max(0, lastPost + 1000 - timers.now());
    if (wait === 0) flush();
    else
      timer = timers.setTimeout(() => {
        timer = undefined;
        flush();
      }, wait);
  };
  const activate = () => {
    if (disposed || !range || !options.active()) return;
    if (range.first <= frontier + 1 && range.last > frontier) {
      frontier = range.last;
      schedule();
    }
    options.onGap?.(range.first > frontier + 1 ? frontier + 1 : null);
  };
  return {
    seen(first: number, last: number) {
      range = { first, last };
      activate();
    },
    activate,
    async settled() {
      // A following unread write or recovery snapshot must see all progress already painted.
      if (timer !== undefined) {
        timers.clearTimeout(timer);
        timer = undefined;
        flush();
      }
      await Promise.all(inFlight);
    },
    // An explicit read's HTTP response may arrive before older live read events. Advance progress,
    // but retain the live baseline so those earlier events are not mistaken for a new unread mark.
    advance(next: number) {
      frontier = Math.max(frontier, next);
      posted = Math.max(posted, next);
      sent = Math.max(sent, next);
      if (options.active()) options.onGap?.(range && range.first > frontier + 1 ? frontier + 1 : null);
    },
    setStart(next: number) {
      if (next < start) {
        frontier = posted = sent = next;
        generation++;
      } else {
        frontier = Math.max(frontier, next);
        posted = Math.max(posted, next);
        sent = Math.max(sent, next);
      }
      start = next;
      if (options.active()) options.onGap?.(range && range.first > frontier + 1 ? frontier + 1 : null);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (timer !== undefined) timers.clearTimeout(timer);
      timer = undefined;
      flush();
    },
  };
};
