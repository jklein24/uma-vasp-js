import { generateToken } from "openpayments/cryptoUtils.js";
import { v4 } from "uuid";
import { GrantModel, GrantStorage } from "./storage.js";
import { GrantFinalization, GrantRequest, GrantState } from "./types.js";
import { canSkipInteraction } from "./utils.js";

export interface GrantService {
  getByIdWithAccess(grantId: string): Promise<GrantModel | undefined>;
  create(grantRequest: GrantRequest): Promise<GrantModel>;
  markPending(grantId: string): Promise<GrantModel | undefined>;
  approve(grantId: string): Promise<GrantModel>;
  finalize(grantId: string, reason: GrantFinalization): Promise<GrantModel>;
  getByContinue(
    continueId: string,
    continueToken: string,
    options?: GetByContinueOpts,
  ): Promise<GrantModel | undefined>;
  revokeGrant(grantId: string): Promise<boolean>;
  updateLastContinuedAt(id: string): Promise<GrantModel>;
}

interface ServiceDependencies {
  storage: GrantStorage;
}

export async function createGrantService({
  storage,
}: ServiceDependencies): Promise<GrantService> {
  const deps = { storage };
  return {
    getByIdWithAccess: (grantId: string) => getByIdWithAccess(deps, grantId),
    create: (grantRequest: GrantRequest) => create(deps, grantRequest),
    markPending: (grantId: string) => markPending(deps, grantId),
    approve: (grantId: string) => approve(deps, grantId),
    finalize: (id: string, reason: GrantFinalization) =>
      finalize(deps, id, reason),
    getByContinue: (
      continueId: string,
      continueToken: string,
      opts: GetByContinueOpts,
    ) => getByContinue(deps, continueId, continueToken, opts),
    revokeGrant: (grantId) => revokeGrant(deps, grantId),
    updateLastContinuedAt: (id) => updateLastContinuedAt(deps, id),
  };
}

async function getByIdWithAccess(
  { storage }: ServiceDependencies,
  grantId: string,
): Promise<GrantModel | undefined> {
  return storage.getGrant(grantId);
}

async function approve(
  { storage }: ServiceDependencies,
  grantId: string,
): Promise<GrantModel> {
  const grant = await storage.getGrant(grantId);
  if (!grant) {
    throw new Error(`Grant not found for grantId: ${grantId}`);
  }
  return storage.upsertGrant({
    ...grant,
    state: GrantState.Approved,
  });
}

async function markPending(
  { storage }: ServiceDependencies,
  grantId: string,
): Promise<GrantModel> {
  const grant = await storage.getGrant(grantId);
  if (!grant) {
    throw new Error(`Grant not found for grantId: ${grantId}`);
  }
  return storage.upsertGrant({
    ...grant,
    state: GrantState.Pending,
  });
}

async function finalize(
  { storage }: ServiceDependencies,
  grantId: string,
  reason: GrantFinalization,
): Promise<GrantModel> {
  const grant = await storage.getGrant(grantId);
  if (!grant) {
    throw new Error(`Grant not found for grantId: ${grantId}`);
  }
  return storage.upsertGrant({
    ...grant,
    state: GrantState.Finalized,
    finalizationReason: reason,
  });
}

async function revokeGrant(
  { storage }: ServiceDependencies,
  grantId: string,
): Promise<boolean> {
  const grant = await storage.getGrant(grantId);
  if (!grant) {
    return false;
  }
  // TODO: Revoke associated accesses and access tokens.
  await storage.upsertGrant({
    ...grant,
    state: GrantState.Finalized,
    finalizationReason: GrantFinalization.Revoked,
  });
  return true;
}

async function create(
  { storage }: ServiceDependencies,
  grantRequest: GrantRequest,
): Promise<GrantModel> {
  const {
    access_token: { access },
    interact,
    client,
  } = grantRequest;

  const grantData: GrantModel = {
    id: v4(),
    createdAt: new Date(),
    updatedAt: new Date(),
    state: canSkipInteraction(grantRequest)
      ? GrantState.Approved
      : GrantState.Pending,
    startMethod: interact?.start ?? [],
    finishMethod: interact?.finish?.method,
    finishUri: interact?.finish?.uri,
    clientNonce: interact?.finish?.nonce,
    client,
    continueId: v4(),
    continueToken: generateToken(),
    lastContinuedAt: new Date(),
    access,
  };

  const grant = await storage.upsertGrant(grantData);

  return grant;
}

interface GetByContinueOpts {
  includeRevoked?: boolean;
}

async function getByContinue(
  deps: ServiceDependencies,
  continueId: string,
  continueToken: string,
  options: GetByContinueOpts = {},
): Promise<GrantModel | undefined> {
  const { includeRevoked = false } = options;

  return await deps.storage.getGrantByContinue(
    continueId,
    continueToken,
    includeRevoked,
  );
}

async function updateLastContinuedAt(
  { storage }: ServiceDependencies,
  grantId: string,
): Promise<GrantModel> {
  const grant = await storage.getGrant(grantId);
  if (!grant) {
    throw new Error(`Grant not found for grantId: ${grantId}`);
  }
  return await storage.upsertGrant({
    ...grant,
    lastContinuedAt: new Date(),
  });
}
