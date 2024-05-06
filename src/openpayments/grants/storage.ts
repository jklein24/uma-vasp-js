import {
  AccessItem,
  Grant as OpenPaymentsGrant,
  GrantContinuation as OpenPaymentsGrantContinuation,
  PendingGrant as OpenPaymentsPendingGrant,
} from "@interledger/open-payments";
import { toOpenPaymentsAccessToken } from "openpayments/accesstoken/service.js";
import { AccessTokenModel } from "openpayments/accesstoken/storage.js";
import {
  FinishMethod,
  GrantFinalization,
  GrantState,
  StartMethod,
} from "./types.js";
import { InteractionModel } from "openpayments/interaction/storage.js";

export type GrantModel = {
  id: string;
  state: GrantState;
  finalizationReason?: GrantFinalization | undefined;
  createdAt: Date;
  updatedAt: Date;
  access: AccessItem[];
  startMethod: StartMethod[];

  continueToken: string;
  continueId: string;
  finishMethod?: FinishMethod | undefined;
  finishUri?: string | undefined;
  client: string;
  clientNonce?: string | undefined; // client-generated nonce for post-interaction hash

  lastContinuedAt: Date;
};

interface ToOpenPaymentsPendingGrantArgs {
  authServerUrl: string;
  client: {
    name: string;
    uri: string;
  };
  waitTimeSeconds?: number;
}

export function toOpenPaymentPendingGrant(
  grant: GrantModel,
  interaction: InteractionModel,
  args: ToOpenPaymentsPendingGrantArgs,
): OpenPaymentsPendingGrant {
  const { authServerUrl, client, waitTimeSeconds } = args;

  const redirectUri = new URL(
    authServerUrl + `/interact/${interaction.id}/${interaction.nonce}`,
  );

  redirectUri.searchParams.set("clientName", client.name);
  redirectUri.searchParams.set("clientUri", client.uri);

  return {
    interact: {
      redirect: redirectUri.toString(),
      finish: interaction.nonce,
    },
    continue: {
      access_token: {
        value: grant.continueToken,
      },
      uri: `${authServerUrl}/continue/${grant.continueId}`,
      wait: waitTimeSeconds || 0,
    },
  };
}

interface ToOpenPaymentsGrantArgs {
  authServerUrl: string;
  waitTimeSeconds?: number;
}

export function toOpenPaymentsGrantContinuation(
  grant: GrantModel,
  args: ToOpenPaymentsGrantArgs,
): OpenPaymentsGrantContinuation {
  return {
    continue: {
      access_token: {
        value: grant.continueToken,
      },
      uri: `${args.authServerUrl}/continue/${grant.continueId}`,
      wait: args.waitTimeSeconds || 0,
    },
  };
}

export function toOpenPaymentsGrant(
  grant: GrantModel,
  args: ToOpenPaymentsGrantArgs,
  accessToken: AccessTokenModel,
): OpenPaymentsGrant {
  return {
    access_token: toOpenPaymentsAccessToken(accessToken, grant.access, {
      authServerUrl: args.authServerUrl,
    }),
    continue: {
      access_token: {
        value: grant.continueToken,
      },
      uri: `${args.authServerUrl}/continue/${grant.continueId}`,
    },
  };
}

export type FinishableGrant = GrantModel & {
  finishMethod: NonNullable<GrantModel["finishMethod"]>;
  finishUri: NonNullable<GrantModel["finishUri"]>;
};

export function isFinishableGrant(grant: GrantModel): grant is FinishableGrant {
  return !!(grant.finishMethod && grant.finishUri);
}

export function isRejectedGrant(grant: GrantModel): boolean {
  return !!(
    grant.state === GrantState.Finalized &&
    grant.finalizationReason === GrantFinalization.Rejected
  );
}

export function isRevokedGrant(grant: GrantModel): boolean {
  return !!(
    grant.state === GrantState.Finalized &&
    grant.finalizationReason === GrantFinalization.Revoked
  );
}

export interface GrantStorage {
  upsertGrant(grant: GrantModel): Promise<GrantModel>;
  getGrant(grantId: string): Promise<GrantModel | undefined>;
  getGrantByContinue(
    continueId: string,
    continueToken: string,
    includeRevoked: boolean,
  ): Promise<GrantModel | undefined>;
  deleteGrant(grantId: string): Promise<void>;
}

export class InMemoryGrantStorage implements GrantStorage {
  private grants: Record<string, GrantModel> = {};
  private grantsByContinue: Record<string, GrantModel> = {};
  private static instance: InMemoryGrantStorage;

  private constructor() {}

  static getInstance(): InMemoryGrantStorage {
    if (!InMemoryGrantStorage.instance) {
      InMemoryGrantStorage.instance = new InMemoryGrantStorage();
    }
    return InMemoryGrantStorage.instance;
  }

  async upsertGrant(grant: GrantModel): Promise<GrantModel> {
    this.grants[grant.id] = grant;
    this.grantsByContinue[grant.continueId] = grant;
    return grant;
  }

  async getGrant(grantId: string): Promise<GrantModel | undefined> {
    return this.grants[grantId];
  }

  async getGrantByContinue(
    continueId: string,
    continueToken: string,
    includeRevoked: boolean,
  ): Promise<GrantModel | undefined> {
    const grant = this.grantsByContinue[continueId];
    if (!grant || grant.continueToken !== continueToken) return undefined;
    if (!includeRevoked && isRevokedGrant(grant)) return undefined;
    return grant;
  }

  async deleteGrant(grantId: string): Promise<void> {
    const grant = this.grants[grantId];
    delete this.grants[grantId];
    delete this.grantsByContinue[grant.continueId];
  }
}
