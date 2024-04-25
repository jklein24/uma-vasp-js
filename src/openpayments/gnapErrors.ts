import { Response } from 'express'

export enum GNAPErrorCode {
    InvalidRequest = 'invalid_request',
    InvalidClient = 'invalid_client',
    InvalidInteraction = 'invalid_interaction',
    InvalidRotation = 'invalid_rotation',
    InvalidContinuation = 'invalid_continuation',
    UserDenied = 'user_denied',
    RequestDenied = 'request_denied',
    UnknownInteraction = 'unknown_interaction',
    TooFast = 'too_fast'
  }
  
  export interface GNAPErrorResponse {
    error: {
      code: GNAPErrorCode
      description?: string
    }
  }
  
  export function throwGNAPError(
    res: Response,
    httpCode: number,
    gnapCode: GNAPErrorCode,
    description?: string
  ): never {
    res.status(httpCode).send({ error: { code: gnapCode, description } })
    throw new Error(`GNAP error ${gnapCode}`); // TODO(jeremy): I'm not sure this is right...
  }