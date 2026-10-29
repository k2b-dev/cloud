import Authority from "./Authority.island";

// Import through JSX so SSR emits the wrapper that the browser bundle mounts.
export default function MachineAuthorityPage() {
  return <Authority />;
}
