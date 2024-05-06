import { getAuthServerOpenAPI } from "@interledger/open-payments";
import { HttpMethod } from "@interledger/openapi";
import { SATS_CURRENCY } from "currencies.js";
import { Express } from "express";
import { fullUrlForRequest } from "networking/expressAdapters.js";
import UmaConfig from "UmaConfig.js";
import { User } from "User.js";
import UserService from "UserService.js";
import { createAccessTokenService } from "./accesstoken/service.js";
import { InMemoryAccessTokenStorage } from "./accesstoken/storage.js";
import ClientAppHelper from "./ClientAppHelper.js";
import { createGrantRoutes } from "./grants/routes.js";
import { createGrantService } from "./grants/service.js";
import { InMemoryGrantStorage } from "./grants/storage.js";
import { createInteractionService } from "./interaction/service.js";
import { InMemoryInteractionStorage } from "./interaction/storage.js";
import {
  createValidatorMiddleware,
  grantContinueHttpsigMiddleware,
  grantInitiationHttpsigMiddleware,
} from "./middleware.js";

export default class AuthService {
  constructor(
    private readonly userService: UserService,
    private readonly clientHelper: ClientAppHelper,
    private readonly config: UmaConfig,
  ) {}

  async registerRoutes(app: Express) {
    app.get("/op/walletAddress/:username", async (req, resp) => {
      const username = req.params.username;
      const user = await this.userService.getUserByUma(username);
      if (!user) {
        resp.status(404).send("User not found.");
        return;
      }

      resp.json(await this.getWalletAddress(user, fullUrlForRequest(req)));
    });

    const grantService = await createGrantService({
      storage: InMemoryGrantStorage.getInstance(),
    });
    const accessTokenService = await createAccessTokenService({
      clientService: this.clientHelper,
      accessTokenExpirySeconds: 60 * 60 * 24 * 7, // 1 week
      tokenStorage: InMemoryAccessTokenStorage.getInstance(),
      grantStorage: InMemoryGrantStorage.getInstance(),
    });
    const interactionService = await createInteractionService({
      grantService,
      interactionStorage: InMemoryInteractionStorage.getInstance(),
      config: this.config,
    });
    const grantRoutes = createGrantRoutes({
      grantService,
      interactionService,
      clientService: this.clientHelper,
      accessTokenService,
      config: this.config,
    });
    const openApiSpec = await getAuthServerOpenAPI();
    const validator = createValidatorMiddleware(openApiSpec, {
      path: "/",
      method: HttpMethod.POST,
    });
    app.post(
      "/",
      validator,
      grantInitiationHttpsigMiddleware.bind(this, this.clientHelper),
      grantRoutes.create,
    );

    const continueValidator = createValidatorMiddleware(openApiSpec, {
      path: "/continue/:id",
      method: HttpMethod.POST,
    });
    app.post(
      "/continue/:id",
      continueValidator,
      grantContinueHttpsigMiddleware.bind(this, this.clientHelper),
      grantRoutes.continue,
    );

    // TODO: Add routes for revoking grants, interactions, etc.

    app.get("/op/resource", async (req, resp) => {
      // TODO
    });
  }

  async getWalletAddress(user: User, requestUrl: URL): Promise<any> {
    const authServer = `${requestUrl.protocol}//${requestUrl.host}/`;
    const resourceServer = `${requestUrl.protocol}//${requestUrl.host}/op/resource`;
    const userCurrencies =
      (await this.userService.getCurrencyPreferencesForUser(user.id)) || [
        SATS_CURRENCY,
      ];

    return {
      id: requestUrl.toString(),
      publicName: user.umaUserName,
      assetCode: userCurrencies[0].code,
      assetScale: userCurrencies[0].decimals,
      authServer,
      resourceServer,
    };
  }
}
