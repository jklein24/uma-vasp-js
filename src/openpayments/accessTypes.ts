import { AccessAction, AccessItem, AccessType } from "@interledger/open-payments";
import { AccessIncomingActions, AccessOutgoingActions, AccessQuoteActions } from "@interledger/open-payments/dist/types.js";

interface BaseAccessRequest {
  identifier?: string;
}

export interface IncomingPaymentRequest extends BaseAccessRequest {
  type: "incoming-payment";
  actions: AccessIncomingActions;
  limits?: never;
}

export interface OutgoingPaymentRequest extends BaseAccessRequest {
  type: "outgoing-payment";
  actions: AccessOutgoingActions;
  limits?: OutgoingPaymentLimit;
  identifier: string;
}

export interface QuoteRequest extends BaseAccessRequest {
  type: "quote";
  actions: AccessQuoteActions;
  limits?: never;
}

export type AccessRequest =
  | IncomingPaymentRequest
  | OutgoingPaymentRequest
  | QuoteRequest;

export function isAction(actions: AccessAction[]): actions is AccessAction[] {
  if (typeof actions !== "object") return false;
  for (const action of actions) {
    if (!Object.values(AccessAction).includes(action)) return false;
  }

  return true;
}

export function isIncomingPaymentAccessRequest(
  accessRequest: AccessItem,
): accessRequest is IncomingPaymentRequest {
  return (
    accessRequest.type === "incoming-payment" &&
    isAction(accessRequest.actions)
  );
}

export function isOutgoingPaymentAccessRequest(
  accessRequest: AccessItem,
): accessRequest is OutgoingPaymentRequest {
  return (
    accessRequest.type === "outgoing-payment" &&
    isAction(accessRequest.actions) &&
    !!accessRequest.identifier
  );
}

export function isQuoteAccessRequest(
  accessRequest: AccessItem,
): accessRequest is QuoteRequest {
  return (
    accessRequest.type === AccessType.Quote &&
    isAction(accessRequest.actions)
  );
}

// value should hold bigint, serialized as string for requests
// & storage as jsonb (postgresql.org/docs/current/datatype-json.html) field in postgres
export interface PaymentAmount {
  value: string;
  assetCode: string;
  assetScale: number;
}

export type OutgoingPaymentLimit = {
  receiver: string;
  debitAmount?: PaymentAmount;
  receiveAmount?: PaymentAmount;
  interval?: string;
};

export type LimitData = OutgoingPaymentLimit;
