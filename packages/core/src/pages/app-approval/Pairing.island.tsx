import PairingDialog from "./Pairing";

export default function Pairing(props: { userId: string; actorId: string; name: string; appOrigin: string; returnTo: string }) {
  return (
    <PairingDialog
      {...props}
      returnTo={`/me/security/pair?${new URLSearchParams({ userId: props.userId })}`}
      onClose={() => window.location.assign(props.returnTo)}
    />
  );
}
