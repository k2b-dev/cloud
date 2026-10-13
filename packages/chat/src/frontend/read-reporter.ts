type Timer = ReturnType<typeof setTimeout> | number;
type Timers = {
  setTimeout(callback: () => void, delay: number): Timer;
  clearTimeout(timer: Timer): void;
  now(): number;
};
export const createReadReporter = (options: { start: number; post(seq: number): Promise<unknown>; active(): boolean; timers?: Timers }) => {
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
  const flush = () => {
    if (frontier <= posted || frontier <= sent) return;
    const seq = frontier;
    sent = seq;
    const epoch = generation;
    lastPost = timers.now();
    // In-flight responses from before a mark-unread cannot erase its new frontier.
    void options
      .post(seq)
      .then(() => {
        if (epoch === generation) posted = Math.max(posted, seq);
      })
      .catch(() => {
        if (epoch === generation && sent === seq) sent = posted;
      });
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
  };
  return {
    seen(first: number, last: number) {
      range = { first, last };
      activate();
    },
    activate,
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
