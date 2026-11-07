import Speedtest from "../ui/Speedtest";

export default function PublicSpeedtest(props: { server: string }) {
  return <Speedtest server={props.server} />;
}
