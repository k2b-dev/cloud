import { Chart } from "../src";
import { Canvas, Pane, Section, Text, Workspace } from "../src/v2";

// A screen with a chart in a Canvas and a section after it: the chart's SVG brings a <style>, after which happy-dom
// dropped the rest of the markup, so the outline of `v2-preview --text` ended at the Canvas (v2-preview.test.ts).
export default function ChartThenSection() {
  return (
    <Workspace>
      <Pane label="Valkey">
        <Section title="Präfixe">
          <Canvas label="Präfixverteilung" height={240}>
            <Chart
              kind="bar"
              style={{ height: "100%" }}
              data={[
                { label: "mail:session", value: 18204 },
                { label: "spaces:presence", value: 9311 },
              ]}
            />
          </Canvas>
        </Section>
        <Section title="Nach dem Bild">
          <Text type="body">Steht im Umriss.</Text>
        </Section>
      </Pane>
    </Workspace>
  );
}
