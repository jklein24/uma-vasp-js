import {
  AccessItem,
  Grant as OpenPaymentsGrant,
  GrantContinuation as OpenPaymentsGrantContinuation,
  PendingGrant as OpenPaymentsPendingGrant,
} from "@interledger/open-payments";
import {
  FinishMethod,
  GrantFinalization,
  GrantState,
  StartMethod,
} from "./types.js";

export type GrantModel = {
  id: string;
  state: GrantState;
  finalizationReason?: GrantFinalization | undefined;
  createdAt: Date;
  updatedAt: Date;
  access: AccessItem[];
  startMethod: StartMethod[];
  identifier: string;

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
  interaction: Interaction,
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
  accessToken: AccessToken,
  accessItems: Access[],
): OpenPaymentsGrant {
  return {
    access_token: toOpenPaymentsAccessToken(accessToken, accessItems, {
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
  getGrantByContinueId(continueId: string): Promise<GrantModel | undefined>;
  deleteGrant(grantId: string): Promise<void>;
}
