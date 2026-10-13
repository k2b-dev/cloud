import Layout from "../../../src/ssr/Layout";
import type { LayoutContext } from "../../../src/ssr/layout-context";
import { richProps } from "./props";
import RichProps from "./RichProps.island";

export default function CspPage(props: { c: LayoutContext }) {
  const data = richProps();
  return (
    <Layout c={props.c} title="CSP props">
      <RichProps at={data.at} map={data.map} set={data.set} shared={data.shared} missing={data.missing} text={data.text} />
    </Layout>
  );
}
