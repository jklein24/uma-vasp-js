import { getAuthServerOpenAPI } from "@interledger/open-payments";
import { HttpMethod } from "@interledger/openapi";
import { SATS_CURRENCY } from "currencies.js";
import { Express } from "express";
import { fullUrlForRequest } from "networking/expressAdapters.js";
import { User } from "User.js";
import UserService from "UserService.js";
import ClientAppHelper from "./ClientAppHelper.js";
import {
  createValidatorMiddleware,
  grantInitiationHttpsigMiddleware,
} from "./middleware.js";

export default class AuthService {
  constructor(
    private readonly userService: UserService,
    private readonly clientHelper: ClientAppHelper,
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
    const openApiSpec = await getAuthServerOpenAPI();
    const validator = createValidatorMiddleware(openApiSpec, {
      path: "/",
      method: HttpMethod.POST,
    });
    app.post(
      "/op/auth/grant",
      validator,
      grantInitiationHttpsigMiddleware.bind(this, this.clientHelper),
      async (req, resp) => {
        // TODO
      },
    );

    app.get("/op/resource", async (req, resp) => {
      // TODO
    });
  }

  async getWalletAddress(user: User, requestUrl: URL): Promise<any> {
    const authServer = `${requestUrl.protocol}//${requestUrl.host}/op/auth`;
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
