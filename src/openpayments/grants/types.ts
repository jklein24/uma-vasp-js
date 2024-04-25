import { AccessRequest } from "../accessTypes.js";

// datatracker.ietf.org/doc/html/draft-ietf-gnap-core-protocol#section-2
export interface GrantRequest {
  access_token: {
    access: AccessRequest[];
  };
  client: string;
  interact?: {
    start: StartMethod[];
    finish?: {
      method: FinishMethod;
      uri: string;
      nonce: string;
    };
  };
}

export interface GrantResponse {
  interact: {
    redirect: string;
    finish: string;
  };
  continue: {
    access_token: {
      value: string;
    };
    uri: string;
    wait: number;
  };
}

export enum StartMethod {
  Redirect = "redirect",
}

export enum FinishMethod {
  Redirect = "redirect",
}

export enum GrantFinalization {
  Issued = "ISSUED",
  Revoked = "REVOKED",
  Rejected = "REJECTED",
}

export enum GrantState {
  Processing = "PROCESSING",
  Pending = "PENDING",
  Approved = "APPROVED",
  Finalized = "FINALIZED",
}

export interface FilterGrantState {
  in?: GrantState[];
  notIn?: GrantState[];
}

export interface FilterGrantFinalization {
  in?: GrantFinalization[];
  notIn?: GrantFinalization[];
}

export interface FilterString {
  in?: string[];
}

export interface GrantFilter {
  identifier?: FilterString;
  state?: FilterGrantState;
  finalizationReason?: FilterGrantFinalization;
}
