type Flight<Value> = {
  generation: number;
  promise: Promise<Value>;
};

/** Coalesces refreshes while preventing invalidated work from committing. */
export class SignerRefreshes<Key, Value> {
  readonly #flights = new Map<Key, Flight<Value>>();
  readonly #generations = new Map<Key, number>();

  run(key: Key, refresh: () => Promise<Value>, commit: (value: Value) => void): Promise<Value> {
    const generation = this.#generations.get(key) ?? 0;
    const current = this.#flights.get(key);
    if (current?.generation === generation) return current.promise;

    const flight: Flight<Value> = {
      generation,
      promise: Promise.resolve()
        .then(refresh)
        .then((value) => {
          if ((this.#generations.get(key) ?? 0) !== generation) {
            throw new Error("Cloud identity signer refresh was invalidated");
          }
          commit(value);
          return value;
        }),
    };
    this.#flights.set(key, flight);
    const cleanup = () => {
      if (this.#flights.get(key) === flight) this.#flights.delete(key);
    };
    void flight.promise.then(cleanup, cleanup);
    return flight.promise;
  }

  invalidate(key: Key): void {
    this.#generations.set(key, (this.#generations.get(key) ?? 0) + 1);
    this.#flights.delete(key);
  }

  invalidateAll(): void {
    for (const key of new Set([...this.#generations.keys(), ...this.#flights.keys()])) this.invalidate(key);
  }
}
