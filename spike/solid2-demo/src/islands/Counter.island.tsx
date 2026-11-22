import { createSignal } from "solid-js";

export default function Counter(props: { initial?: number }) {
  const [count, setCount] = createSignal(props.initial ?? 0);
  return (
    <button type="button" data-testid="counter" onClick={() => setCount((c) => c + 1)}>
      Count: {count()}
    </button>
  );
}
