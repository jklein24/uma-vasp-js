import {
  getKeyId,
  RequestLike,
  validateSignature,
  validateSignatureHeaders,
} from "@interledger/http-signature-utils";
import {
  GrantContinuationRequest,
  GrantRequest,
} from "@interledger/open-payments";
import {
  isValidationError,
  OpenAPI,
  RequestOptions,
} from "@interledger/openapi";
import { NextFunction, Request, RequestHandler, Response } from "express";
import ClientAppHelper from "./ClientAppHelper.js";
import { GNAPErrorCode, throwGNAPError } from "./gnapErrors.js";

interface ValidationOptions {
  validateRequest?: boolean;
  validateResponse?: boolean;
}

function expressReqToRequestLike(req: Request): RequestLike {
  const reqLike: RequestLike = {
    url: req.url,
    method: req.method,
    headers: req.headers ? JSON.parse(JSON.stringify(req.headers)) : undefined,
  };
  if (req.body) {
    reqLike.body = JSON.stringify(req.body);
  }
  return reqLike;
}

export function createValidatorMiddleware<T>(
  spec: OpenAPI,
  options: RequestOptions,
  validationOptions: ValidationOptions | undefined = {
    validateRequest: true,
    validateResponse: false,
  },
): RequestHandler {
  const requestValidator = spec.createRequestValidator<T>(options);

  return async (req, res, next): Promise<void> => {
    if (validationOptions?.validateRequest) {
      try {
        requestValidator(req);
      } catch (err) {
        if (isValidationError(err)) {
          throw new OpenAPIValidatorMiddlewareError(
            `Received error validating OpenAPI request: ${err.errors[0]?.message}`,
            err.status || 400,
          );
        }

        throw err; // Should not be possible (only ValidationError is thrown in requestValidator)
      }
    }

    next();

    // TODO: Figure out how to implement response validation for express.
    // const responseValidator = spec.createResponseValidator(options)
    // if (validationOptions?.validateResponse) {
    //   try {
    //     responseValidator({ body: , status })
    //   } catch (err) {
    //     if (isValidationError(err)) {
    //       throw new OpenAPIValidatorMiddlewareError(
    //           `Received error validating OpenAPI response: ${err.errors[0]?.message}`,
    //           err.status || 500
    //         )
    //     }

    //     throw err // Should not be possible (only ValidationError is thrown in responseValidator)
    //   }
    // }
  };
}

async function verifySigFromClient(
  clientHelper: ClientAppHelper,
  client: string,
  request: RequestLike,
  response: Response,
): Promise<boolean> {
  const sigInput = request.headers["signature-input"] as string;
  const keyId = getKeyId(sigInput);
  if (!keyId) {
    throwGNAPError(
      response,
      401,
      GNAPErrorCode.InvalidClient,
      "invalid signature input",
    );
  }

  const clientKey = await clientHelper.getClientKey({
    client,
    keyId,
  });

  if (!clientKey) {
    throwGNAPError(
      response,
      400,
      GNAPErrorCode.InvalidClient,
      "could not determine client",
    );
  }
  return validateSignature(clientKey, request);
}

export async function grantContinueHttpsigMiddleware(
  clientHelper: ClientAppHelper,
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  if (
    !validateSignatureHeaders(expressReqToRequestLike(request)) ||
    !request.headers["authorization"] ||
    typeof request.headers["authorization"] !== "string"
  ) {
    throwGNAPError(
      response,
      401,
      GNAPErrorCode.InvalidClient,
      "invalid signature headers",
    );
  }

  const continueToken = request.headers["authorization"].replace(
    "GNAP ",
    "",
  ) as string;
  const interactRef = (request.body as GrantContinuationRequest | undefined)
    ?.interact_ref;

  console.info(
    {
      continueToken,
      interactRef,
      continueId: request.params["id"],
    },
    "httpsig for continue",
  );

  const grantService = await ctx.container.use("grantService");
  const grant = await grantService.getByContinue(
    request.params["id"],
    continueToken,
  );

  if (!grant) {
    throwGNAPError(
      response,
      401,
      GNAPErrorCode.InvalidContinuation,
      "invalid grant",
    );
  }

  const sigVerified = await verifySigFromClient(
    clientHelper,
    grant.client,
    expressReqToRequestLike(request),
    response,
  );
  if (!sigVerified) {
    throwGNAPError(
      response,
      401,
      GNAPErrorCode.InvalidClient,
      "invalid signature",
    );
  }
  await next();
}

export async function grantInitiationHttpsigMiddleware(
  clientHelper: ClientAppHelper,
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  if (!validateSignatureHeaders(expressReqToRequestLike(request))) {
    throwGNAPError(
      response,
      401,
      GNAPErrorCode.InvalidClient,
      "invalid signature headers",
    );
  }

  if (!request.body) {
    throwGNAPError(response, 400, GNAPErrorCode.InvalidRequest, "no body");
  }

  const body = JSON.parse(request.body) as GrantRequest;

  const sigVerified = await verifySigFromClient(
    clientHelper,
    body.client,
    expressReqToRequestLike(request),
    response,
  );
  if (!sigVerified) {
    throwGNAPError(
      response,
      401,
      GNAPErrorCode.InvalidClient,
      "invalid signature",
    );
  }
  await next();
}

export class OpenAPIValidatorMiddlewareError extends Error {
  public status?: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "OpenAPIValidatorMiddlewareError";
    this.status = status;
  }
}
