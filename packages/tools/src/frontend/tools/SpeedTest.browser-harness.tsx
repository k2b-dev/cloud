import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import { Metric } from "./SpeedTest.island";

render(
  () => (
    <LocaleProvider locale={document.documentElement.lang}>
      <main class="paper p-4 grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div id="download">
          <Metric
            label="Download"
            value="91"
            unit="Mbps"
            icon="ti ti-download"
            active={false}
            series={[94.123456, 80, 91]}
            seriesColor="text-blue-500 dark:text-blue-400"
          />
        </div>
        <div id="ping">
          <Metric
            label="Ping"
            value="9,0"
            unit="ms"
            icon="ti ti-activity"
            active={false}
            series={[8.26, 12, 9]}
            seriesColor="text-amber-500 dark:text-amber-400"
          />
        </div>
      </main>
    </LocaleProvider>
  ),
  document.getElementById("root")!,
);
