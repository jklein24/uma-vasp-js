import {
  AccountTokenAuthProvider,
  LightsparkClient,
} from "@lightsparkdev/lightspark-sdk";
import { InMemoryPublicKeyCache } from "@uma-sdk/core";
import InMemoryNonceValidator from "demo/InMemoryNonceValidator.js";
import DemoComplianceService from "./demo/DemoComplianceService.js";
import DemoInternalLedgerService from "./demo/DemoInternalLedgerService.js";
import DemoUserService from "./demo/DemoUserService.js";
import InMemorySendingVaspRequestCache from "./demo/InMemorySendingVaspRequestCache.js";
import { createUmaServer } from "./server.js";
import UmaConfig from "./UmaConfig.js";

// In a real implementation, you'd replace the demo implementations of all of the services with your
// own when constructing the server.
const config = UmaConfig.fromEnvironment();
const lightsparkClient = new LightsparkClient(
  new AccountTokenAuthProvider(config.apiClientID, config.apiClientSecret),
  config.clientBaseURL,
);
const userService = new DemoUserService();
const oneWeekAgo = Date.now() - 1000 * 60 * 60 * 24 * 7;

const umaServer = createUmaServer(
  config,
  lightsparkClient,
  new InMemoryPublicKeyCache(),
  new InMemorySendingVaspRequestCache(),
  userService,
  new DemoInternalLedgerService(config, userService, lightsparkClient),
  new DemoComplianceService(config, lightsparkClient),
  new InMemoryNonceValidator(oneWeekAgo),
);

let port = 8080;
if (process.env.PORT) {
  port = parseInt(process.env.PORT);
}
umaServer.listen(port, () => {
  console.log(`Server started on port ${port}`);
});
