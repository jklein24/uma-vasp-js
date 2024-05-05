import {
  AccessItem,
  AccessToken as OpenPaymentsAccessToken,
} from "@interledger/open-payments";
import ClientAppHelper from "openpayments/ClientAppHelper.js";
import { generateToken } from "openpayments/cryptoUtils.js";
import {
  GrantModel,
  GrantStorage,
  isRevokedGrant,
} from "openpayments/grants/storage.js";
import { AccessTokenModel, AccessTokenStorage } from "./storage.js";

export interface AccessTokenService {
  introspect(tokenValue: string): Promise<GrantModel | undefined>;
  create(grantId: string): Promise<AccessTokenModel>;
  revoke(tokenValue: string): Promise<AccessTokenModel | undefined>;
  revokeByGrantId(grantId: string): Promise<AccessTokenModel | undefined>;
}

interface ServiceDependencies {
  clientService: ClientAppHelper;
  accessTokenExpirySeconds: number;
  tokenStorage: AccessTokenStorage;
  grantStorage: GrantStorage;
}

export async function createAccessTokenService(
  deps: ServiceDependencies,
): Promise<AccessTokenService> {
  return {
    introspect: (tokenValue: string) => introspect(deps, tokenValue),
    revoke: (tokenValue: string) => revoke(deps, tokenValue),
    revokeByGrantId: (grantId: string) => revokeByGrantId(deps, grantId),
    create: (grantId: string) => createAccessToken(deps, grantId),
  };
}

function isTokenExpired(token: AccessTokenModel): boolean {
  const now = new Date(Date.now());
  const expiresAt = token.createdAt.getTime() + token.expiresIn * 1000;
  return expiresAt < now.getTime();
}

async function introspect(
  deps: ServiceDependencies,
  tokenValue: string,
): Promise<GrantModel | undefined> {
  const token = await deps.tokenStorage.getByValue(tokenValue);

  if (!token || isTokenExpired(token)) return undefined;

  const grant = await deps.grantStorage.getGrant(token.grantId);
  if (!grant || isRevokedGrant(grant)) {
    return undefined;
  }

  return grant;
}

async function revoke(
  deps: ServiceDependencies,
  tokenValue: string,
): Promise<AccessTokenModel | undefined> {
  return deps.tokenStorage.delete(tokenValue);
}

async function revokeByGrantId(
  deps: ServiceDependencies,
  grantId: string,
): Promise<AccessTokenModel | undefined> {
  const token = await deps.tokenStorage.getAccessTokenForGrant(grantId);
  if (!token) return undefined;
  return deps.tokenStorage.delete(token.value);
}

async function createAccessToken(
  deps: ServiceDependencies,
  grantId: string,
): Promise<AccessTokenModel> {
  const token = {
    value: generateToken(),
    grantId,
    createdAt: new Date(),
    expiresIn: deps.accessTokenExpirySeconds,
  };
  return deps.tokenStorage.upsertAccessToken(token);
}

interface ToOpenPaymentsAccessTokenArgs {
  authServerUrl: string;
}

export function toOpenPaymentsAccessToken(
  accessToken: AccessTokenModel,
  accessItems: AccessItem[],
  args: ToOpenPaymentsAccessTokenArgs,
): OpenPaymentsAccessToken["access_token"] {
  return {
    access: accessItems,
    value: accessToken.value,
    manage: `${args.authServerUrl}/token/${accessToken.grantId}`,
    expires_in: accessToken.expiresIn,
  };
}
