import SignOutButton from "./SignOutButton";

/** The sign-out action of a page that is otherwise static. */
export default function SignOut(props: { cloud: string }) {
  return <SignOutButton cloud={props.cloud} />;
}
