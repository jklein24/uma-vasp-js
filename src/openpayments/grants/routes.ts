import { Request, Response } from "express";
import ClientAppHelper from "openpayments/ClientAppHelper.js";
import { GNAPErrorCode, throwGNAPError } from "../gnapErrors.js";
import { GrantService } from "./service.js";
import {
  GrantModel,
  isRejectedGrant,
  isRevokedGrant,
  toOpenPaymentPendingGrant,
  toOpenPaymentsGrant,
  toOpenPaymentsGrantContinuation,
} from "./storage.js";
import { GrantFinalization, GrantState } from "./types.js";
import { canSkipInteraction } from "./utils.js";
import { AccessTokenService } from "openpayments/accesstoken/service.js";
import { AccessTokenModel } from "openpayments/accesstoken/storage.js";

interface ServiceDependencies {
  grantService: GrantService;
  clientService: ClientAppHelper;
  accessTokenService: AccessTokenService
  // interactionService: InteractionService
  // config: IAppConfig
}

export interface GrantRoutes {
  create(req: Request, res: Response): Promise<void>;
  continue(req: Request, res: Response): Promise<void>;
  revoke(req: Request, res: Response): Promise<void>;
}

export function createGrantRoutes(deps: ServiceDependencies): GrantRoutes {
  return {
    create: (req: Request, res: Response) => createGrant(deps, req, res),
    continue: (req: Request, res: Response) => continueGrant(deps, req, res),
    revoke: (req: Request, res: Response) => revokeGrant(deps, req, res),
  };
}

async function createGrant(
  deps: ServiceDependencies,
  req: Request,
  res: Response,
): Promise<void> {
  let noInteractionRequired: boolean;
  try {
    noInteractionRequired = canSkipInteraction(req.body);
  } catch (err) {
    throwGNAPError(
      res,
      400,
      GNAPErrorCode.InvalidRequest,
      "access identifier required",
    );
  }
  if (noInteractionRequired) {
    await createApprovedGrant(deps, req, res);
  } else {
    await createPendingGrant(deps, req, res);
  }
}

async function createApprovedGrant(
  deps: ServiceDependencies,
  req: Request,
  res: Response,
): Promise<void> {
  const { body } = req;
  const { grantService } = deps;
  let grant: GrantModel;
  let accessToken: AccessTokenModel;
  try {
    grant = await grantService.create(body);
    accessToken = await deps.accessTokenService.create(grant.id)
    // await trx.commit()
  } catch (err) {
    // await trx.rollback()
    throwGNAPError(
      res,
      500,
      GNAPErrorCode.RequestDenied,
      "internal server error",
    );
  }
  const access = grant.access;
  res.status(200);
  res.json(
    toOpenPaymentsGrant(
      grant,
      { authServerUrl: config.authServerDomain },
      accessToken,
    ),
  );
}

async function createPendingGrant(
  deps: ServiceDependencies,
  req: Request,
  res: Response,
): Promise<void> {
  const { body } = req;
  const { grantService } = deps;
  if (!body.interact) {
    throwGNAPError(
      res,
      400,
      GNAPErrorCode.InvalidRequest,
      "missing required request field 'interact'",
    );
  }

  const client = await deps.clientService.getClient(body.client);
  if (!client) {
    throwGNAPError(
      res,
      400,
      GNAPErrorCode.InvalidClient,
      "missing required request field 'client'",
    );
  }

  try {
    const grant = await grantService.create(body);
    // TODO: Save the interaction
    // const interaction = await interactionService.create(grant.id)
    // await trx.commit()

    res.status(200);
    res.send(
      toOpenPaymentPendingGrant(grant, interaction, {
        client,
        authServerUrl: config.authServerDomain,
        waitTimeSeconds: config.waitTimeSeconds,
      }),
    );
  } catch (err) {
    // await trx.rollback()
    throwGNAPError(
      res,
      500,
      GNAPErrorCode.RequestDenied,
      "internal server error",
    );
  }
}

function isMatchingContinueRequest(
  reqContinueId: string,
  reqContinueToken: string,
  grant: GrantModel,
): boolean {
  return (
    reqContinueId === grant.continueId &&
    reqContinueToken === grant.continueToken
  );
}

function isContinuableGrant(grant: GrantModel): boolean {
  return !isRejectedGrant(grant) && !isRevokedGrant(grant);
}

function isGrantStillWaiting(
  grant: GrantModel,
  waitTimeSeconds: number,
): boolean {
  const grantWaitTime =
    grant.lastContinuedAt.getTime() + waitTimeSeconds * 1000;
  const currentTime = Date.now();

  return currentTime < grantWaitTime;
}

async function pollGrantContinuation(
  deps: ServiceDependencies,
  req: Request,
  res: Response,
  continueId: string,
  continueToken: string,
): Promise<void> {
  const { config, grantService, accessTokenService } = deps;

  const grant = await grantService.getByContinue(continueId, continueToken);
  if (!grant) {
    throwGNAPError(res, 404, GNAPErrorCode.InvalidRequest, "grant not found");
  }

  if (isGrantStillWaiting(grant, config.waitTimeSeconds)) {
    throwGNAPError(
      res,
      400,
      GNAPErrorCode.TooFast,
      'polled grant faster than "wait" period',
    );
  }

  /*
    https://datatracker.ietf.org/doc/html/draft-ietf-gnap-core-protocol-15#name-continuing-during-pending-i
    "When the client instance does not include a finish parameter, the client instance will often need to poll the AS until the RO has authorized the request."
  */
  if (grant.finishMethod) {
    throwGNAPError(
      res,
      401,
      GNAPErrorCode.RequestDenied,
      "grant cannot be polled",
    );
  } else if (
    grant.state === GrantState.Pending ||
    grant.state === GrantState.Processing
  ) {
    await grantService.updateLastContinuedAt(grant.id);
    res.status(200).json(
      toOpenPaymentsGrantContinuation(grant, {
        authServerUrl: config.authServerDomain,
        waitTimeSeconds: config.waitTimeSeconds,
      }),
    );
    return;
  } else if (
    grant.state !== GrantState.Approved ||
    !isContinuableGrant(grant)
  ) {
    throwGNAPError(
      res,
      401,
      GNAPErrorCode.RequestDenied,
      "grant cannot be continued",
    );
  } else {
    const accessToken = await accessTokenService.create(grant.id);
    await grantService.finalize(grant.id, GrantFinalization.Issued);
    res.status(200).send(
      toOpenPaymentsGrant(
        grant,
        {
          authServerUrl: config.authServerDomain,
        },
        accessToken,
      ),
    );
    return;
  }
}

/* 
  GNAP indicates that a grant may be continued even if it didn't require interaction.
  Rafiki only needs to continue a grant if it required an interaction, noninteractive grants immediately issue an access token without needing continuation
  so continuation only expects interactive grants to be continued.
*/
async function continueGrant(
  deps: ServiceDependencies,
  req: Request,
  res: Response,
): Promise<void> {
  const { id: continueId } = req.params;
  const continueToken = (req.headers["authorization"] as string)?.split(
    "GNAP ",
  )[1];

  if (!continueId || !continueToken) {
    throwGNAPError(
      res,
      401,
      GNAPErrorCode.InvalidContinuation,
      "missing continuation information",
    );
  }

  const {
    accessTokenService,
    grantService,
  } = deps;

  if (!req.body || Object.keys(req.body).length === 0) {
    await pollGrantContinuation(deps, req, res, continueId, continueToken);
    return;
  }

  const { interact_ref: interactRef } = req.body;
  if (!interactRef) {
    throwGNAPError(
      res,
      401,
      GNAPErrorCode.InvalidRequest,
      "missing interaction reference",
    );
  }

  const interaction = await interactionService.getByRef(interactRef);
  // TODO: distinguish error reasons between missing interaction, revoked, etc.
  // https://github.com/interledger/rafiki/issues/2344
  if (
    !interaction ||
    !isContinuableGrant(interaction.grant) ||
    !isMatchingContinueRequest(continueId, continueToken, interaction.grant)
  ) {
    throwGNAPError(
      res,
      404,
      GNAPErrorCode.InvalidContinuation,
      "grant not found",
    );
  } else if (isGrantStillWaiting(interaction.grant, config.waitTimeSeconds)) {
    throwGNAPError(
      res,
      400,
      GNAPErrorCode.TooFast,
      'continued grant faster than "wait" period',
    );
  } else {
    const { grant } = interaction;
    if (grant.state !== GrantState.Approved) {
      throwGNAPError(
        res,
        401,
        GNAPErrorCode.RequestDenied,
        "grant interaction not approved",
      );
    }

    const accessToken = await accessTokenService.create(grant.id);
    await grantService.finalize(grant.id, GrantFinalization.Issued);

    // TODO: add "continue" to response if additional grant request steps are added
    res.json(
      toOpenPaymentsGrant(
        interaction.grant,
        { authServerUrl: config.authServerDomain },
        accessToken,
      ),
    );
  }
}

async function revokeGrant(
  deps: ServiceDependencies,
  req: Request,
  res: Response,
): Promise<void> {
  const { id: continueId } = req.params;
  const continueToken = (req.headers["authorization"] as string)?.split(
    "GNAP ",
  )[1];
  if (!continueId || !continueToken) {
    throwGNAPError(
      res,
      401,
      GNAPErrorCode.InvalidRequest,
      "invalid continuation information",
    );
  }
  const grant = await deps.grantService.getByContinue(
    continueId,
    continueToken,
  );
  if (!grant) {
    throwGNAPError(res, 404, GNAPErrorCode.InvalidRequest, "unknown grant");
  }

  const revoked = await deps.grantService.revokeGrant(grant.id);
  if (!revoked) {
    throwGNAPError(res, 404, GNAPErrorCode.InvalidRequest, "invalid grant");
  }
  res.status(204).send();
}
