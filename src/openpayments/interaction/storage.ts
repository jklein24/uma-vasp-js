import { GrantModel } from "openpayments/grants/storage.js";

export enum InteractionState {
  Pending = "PENDING", // Awaiting interaction from resource owner (RO)
  Approved = "APPROVED", // RO approved interaction
  Denied = "DENIED", // RO Rejected interaction
}

export interface InteractionModel {
  id: string;
  state: InteractionState;
  grantId: string;
  ref: string;
  nonce: string;
  createdAt: Date;
  expiresIn: number;
  grant?: GrantModel | undefined;
}

export interface InteractionWithGrant extends InteractionModel {
  grant: NonNullable<InteractionModel["grant"]>;
}

export function isInteractionWithGrant(
  interaction: InteractionModel,
): interaction is InteractionWithGrant {
  return !!interaction.grant;
}

export interface InteractionStorage {
  getInteractionByGrant(grantId: string): Promise<InteractionModel | undefined>;
  getBySession(
    id: string,
    nonce: string,
  ): Promise<InteractionModel | undefined>;
  approve(id: string): Promise<InteractionModel | undefined>;
  deny(id: string): Promise<InteractionModel | undefined>;
  getByRef(ref: string): Promise<InteractionModel | undefined>;
  upsertInteraction(interaction: InteractionModel): Promise<InteractionModel>;
}

export class InMemoryInteractionStorage implements InteractionStorage {
  private interactions: Record<string, InteractionModel> = {};
  private interactionsByGrant: Record<string, InteractionModel> = {};
  private interactionsBySession: Record<string, InteractionModel> = {};
  private interactionsByRef: Record<string, InteractionModel> = {};
  private static instance: InMemoryInteractionStorage;

  private constructor() {}

  static getInstance(): InMemoryInteractionStorage {
    if (!InMemoryInteractionStorage.instance) {
      InMemoryInteractionStorage.instance = new InMemoryInteractionStorage();
    }
    return InMemoryInteractionStorage.instance;
  }

  async getInteractionByGrant(
    grantId: string,
  ): Promise<InteractionModel | undefined> {
    return this.interactionsByGrant[grantId];
  }

  async getBySession(
    id: string,
    nonce: string,
  ): Promise<InteractionModel | undefined> {
    const sessionKey = `${id}:${nonce}`;
    return this.interactionsBySession[sessionKey];
  }

  async getByRef(ref: string): Promise<InteractionModel | undefined> {
    return this.interactionsByRef[ref];
  }

  async upsertInteraction(
    interaction: InteractionModel,
  ): Promise<InteractionModel> {
    this.interactions[interaction.id] = interaction;
    this.interactionsByGrant[interaction.grantId] = interaction;
    this.interactionsBySession[`${interaction.id}:${interaction.nonce}`] =
      interaction;
    this.interactionsByRef[interaction.ref] = interaction;
    return interaction;
  }

  async approve(id: string): Promise<InteractionModel | undefined> {
    const interaction = this.interactions[id];
    if (!interaction) return undefined;
    this.interactions[id] = {
      ...interaction,
      state: InteractionState.Approved,
    };
    return this.interactions[id];
  }

  async deny(id: string): Promise<InteractionModel | undefined> {
    const interaction = this.interactions[id];
    if (!interaction) return undefined;
    this.interactions[id] = {
      ...interaction,
      state: InteractionState.Denied,
    };
    return this.interactions[id];
  }
}
