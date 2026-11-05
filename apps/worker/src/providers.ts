import type { Provider } from "@skail/runtime";
import { buildConfig } from "./build-config.generated.js";
import { BillingFunctions } from "./billing-functions.js";
import { BillingOperations } from "./billing-operations.js";
import { FakeCityHall, SimulatedCityHall } from "./city-hall.js";
import { HttpProgressNotifier } from "./web.js";

// The skail bundle cannot read environment variables: these settings are fixed at build time (gen-config.mjs).
export const providers: Provider[] = [
  {
    token: BillingFunctions,
    useFactory: () =>
      new BillingFunctions(
        new BillingOperations(
          buildConfig.cityHallProvider === "fake"
            ? new FakeCityHall()
            : new SimulatedCityHall(buildConfig.cityHallOutagePercent),
          new HttpProgressNotifier(buildConfig.webBaseUrl),
        ),
      ),
  },
];
