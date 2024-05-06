import { generateNonce } from "openpayments/cryptoUtils.js";
import { GrantService } from "openpayments/grants/service.js";
import UmaConfig from "UmaConfig.js";
import { v4 } from "uuid";
import {
  InteractionModel,
  InteractionState,
  InteractionStorage,
  InteractionWithGrant,
} from "./storage.js";

export interface InteractionService {
  getInteractionByGrant(grantId: string): Promise<InteractionWithGrant | void>;
  getBySession(id: string, nonce: string): Promise<InteractionWithGrant | void>;
  getByRef(ref: string): Promise<InteractionWithGrant | void>;
  create(grantId: string): Promise<InteractionModel>;
  approve(id: string): Promise<InteractionModel | void>;
  deny(id: string): Promise<InteractionModel | void>;
}

interface ServiceDependencies {
  grantService: GrantService;
  interactionStorage: InteractionStorage;
  config: UmaConfig;
}

const INTERATION_EXPIRY_SECONDS = 300;

export async function createInteractionService(
  deps: ServiceDependencies,
): Promise<InteractionService> {
  return {
    getInteractionByGrant: (grantId: string) =>
      getInteractionByGrant(deps, grantId),
    getBySession: (id: string, nonce: string) => getBySession(deps, id, nonce),
    getByRef: (ref: string) => getByRef(deps, ref),
    create: (grantId: string) => create(deps, grantId),
    approve: (id: string) => approve(deps, id),
    deny: (id: string) => deny(deps, id),
  };
}

async function getInteractionByGrant(
  deps: ServiceDependencies,
  grantId: string,
): Promise<InteractionWithGrant | void> {
  const interaction =
    await deps.interactionStorage.getInteractionByGrant(grantId);
  const grant = await deps.grantService.getByIdWithAccess(grantId);

  if (!interaction || !grant) {
    return undefined;
  }

  return { ...interaction, grant };
}

async function create(
  deps: ServiceDependencies,
  grantId: string,
): Promise<InteractionModel> {
  const interaction = await deps.interactionStorage.upsertInteraction({
    id: v4(),
    grantId,
    ref: v4(),
    nonce: generateNonce(),
    state: InteractionState.Pending,
    createdAt: new Date(),
    expiresIn: INTERATION_EXPIRY_SECONDS,
  });

  return interaction;
}

async function getBySession(
  deps: ServiceDependencies,
  id: string,
  nonce: string,
): Promise<InteractionWithGrant | undefined> {
  const interaction = await deps.interactionStorage.getBySession(id, nonce);

  if (!interaction) {
    return undefined;
  }

  const grant = await deps.grantService.getByIdWithAccess(interaction.grantId);
  if (!grant) {
    return undefined;
  }

  return { ...interaction, grant };
}

async function getByRef(
  deps: ServiceDependencies,
  ref: string,
): Promise<InteractionWithGrant | void> {
  const interaction = await deps.interactionStorage.getByRef(ref);

  if (!interaction) {
    return undefined;
  }

  const grant = await deps.grantService.getByIdWithAccess(interaction.grantId);
  if (!grant) {
    return undefined;
  }

  return { ...interaction, grant };
}

async function approve(
  deps: ServiceDependencies,
  id: string,
): Promise<InteractionModel | undefined> {
  return await deps.interactionStorage.approve(id);
}

async function deny(
  deps: ServiceDependencies,
  id: string,
): Promise<InteractionModel | undefined> {
  return await deps.interactionStorage.deny(id);
}
