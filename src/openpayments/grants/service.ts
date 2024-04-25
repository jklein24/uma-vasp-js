import { Grant } from "@interledger/open-payments";
import { v4 } from "uuid";
import { GrantModel, GrantStorage } from "./storage.js";
import {
  GrantFilter,
  GrantFinalization,
  GrantRequest,
  GrantState,
} from "./types.js";
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
  lock(grantId: string, timeoutMs?: number): Promise<void>;
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
    finalize: (id: string, reason: GrantFinalization) => finalize(id, reason),
    getByContinue: (
      continueId: string,
      continueToken: string,
      opts: GetByContinueOpts,
    ) => getByContinue(continueId, continueToken, opts),
    revokeGrant: (grantId) => revokeGrant(deps, grantId),
    updateLastContinuedAt: (id) => updateLastContinuedAt(id),
    lock: (grantId: string, timeoutMs?: number) =>
      lock(deps, grantId, timeoutMs),
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
    access: [],
    identifier: access[0].identifier ?? "",
  };

  const grant = await storage.upsertGrant(grantData);

  // Associate provided accesses with grant
  // await accessService.createAccess(grant.id, access, grantTrx);

  return grant;
}

interface GetByContinueOpts {
  includeRevoked?: boolean;
}

async function getByContinue(
  continueId: string,
  continueToken: string,
  options: GetByContinueOpts = {},
): Promise<GrantModel | undefined> {
  const { includeRevoked = false } = options;

  const queryBuilder = Grant.query()
    .findOne({ continueId, continueToken })
    .withGraphFetched("interaction");

  if (!includeRevoked) {
    queryBuilder.andWhere((queryBuilder) => {
      queryBuilder.whereNull("finalizationReason");
      queryBuilder.orWhereNot("finalizationReason", GrantFinalization.Revoked);
    });
  }

  const grant = await queryBuilder;

  return grant;
}

async function getGrantsPage(
  deps: ServiceDependencies,
  pagination?: Pagination,
  filter?: GrantFilter,
  sortOrder?: SortOrder,
): Promise<Grant[]> {
  const query = Grant.query(deps.knex).withGraphJoined("access");
  const { identifier, state, finalizationReason } = filter ?? {};

  if (identifier?.in?.length) {
    query.whereIn("access.identifier", identifier.in);
  }

  if (state?.in?.length) {
    query.whereIn("state", state.in);
  }

  if (state?.notIn?.length) {
    query.whereNotIn("state", state.notIn);
  }

  if (finalizationReason?.in?.length) {
    query.whereIn("finalizationReason", finalizationReason.in);
  }

  if (finalizationReason?.notIn?.length) {
    query
      .whereNull("finalizationReason")
      .orWhereNotIn("finalizationReason", finalizationReason.notIn);
  }

  return query.getPage(pagination, sortOrder);
}

async function updateLastContinuedAt(id: string): Promise<Grant> {
  return Grant.query().patchAndFetchById(id, {
    lastContinuedAt: new Date(),
  });
}

async function lock(
  deps: ServiceDependencies,
  grantId: string,
  trx: Transaction,
  timeoutMs?: number,
): Promise<void> {
  const grants = await trx<Grant>(Grant.tableName)
    .select()
    .where("id", grantId)
    .forNoKeyUpdate()
    .timeout(timeoutMs ?? 5000);

  if (grants.length <= 0) {
    deps.logger.warn(
      `No grant found when attempting to lock grantId: ${grantId}`,
    );
  }
}
