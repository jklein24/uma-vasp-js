import {
  isIncomingPaymentAccessRequest,
  isQuoteAccessRequest,
} from "../accessTypes.js";
import { GrantRequest } from "./types.js";

export function canSkipInteraction(body: GrantRequest): boolean {
  return body.access_token.access.every((access) => {
    const canSkip =
      isIncomingPaymentAccessRequest(access) || isQuoteAccessRequest(access);
    if (!canSkip && (!access.identifier || access.identifier === "")) {
      throw new Error("identifier required");
    }
    return canSkip;
  });
}
