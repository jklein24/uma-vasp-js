import { hexToBytes } from "@lightsparkdev/core";
import {
  LightsparkClient,
  LightsparkNode,
} from "@lightsparkdev/lightspark-sdk";
import * as uma from "@uma-sdk/core";
import { Express, Request, Response } from "express";
import { errorMessage } from "./errors.js";
import UmaConfig from "./UmaConfig.js";
import { getLightsparkNodeQuery } from "@lightsparkdev/lightspark-sdk";

export default class ReceivingVasp {
  constructor(
    private readonly config: UmaConfig,
    private readonly lightsparkClient: LightsparkClient,
    private readonly pubKeyCache: uma.PublicKeyCache,
    app: Express,
  ) {
    app.get(
      "/.well-known/lnurlp/:username",
      this.handleLnrulpRequest.bind(this),
    );

    app.get("/api/lnurl/payreq/:uuid", this.handleLnurlPayreq.bind(this));

    app.post("/api/uma/payreq/:uuid", this.handleUmaPayreq.bind(this));
  }

  private async handleLnrulpRequest(req: Request, res: Response, next: any) {
    const username = req.params.username;
    if (
      username !== this.config.username &&
      username !== `$${this.config.username}`
    ) {
      return next(new Error("User not found."));
    }

    const isUma = uma.isUmaLnurlpQuery(
      new URL(req.url, `${req.protocol}://${req.hostname}`),
    );

    if (isUma) {
      return this.handleUmaLnurlp(req, res, next);
    } else {
      // Fall back to normal LNURLp.
      const callback = this.getLnurlpCallback(req, false);
      const metadata = this.getEncodedMetadata(req);
      res.send({
        callback: callback,
        maxSendable: 10_000_000,
        minSendable: 1_000,
        metadata: metadata,
        tag: "payRequest",
      });
    }
    res.send("ok");
  }

  private async handleUmaLnurlp(req: Request, res: Response, next: any) {
    let umaQuery: uma.LnurlpRequest;
    try {
      umaQuery = uma.parseLnurlpRequest(
        new URL(req.url, `${req.protocol}://${req.headers.host}`),
      );
    } catch (e: any) {
      if (e instanceof uma.UnsupportedVersionError) {
        // For unsupported versions, return a 412 "Precondition Failed" as per the spec.
        res.status(412).send({
          supportedMajorVersions: e.supportedMajorVersions,
          unsupportedVersion: e.unsupportedVersion,
        });
        return;
      }
      return next(new Error("Invalid UMA query.", { cause: e }));
    }

    let pubKeys: uma.PubKeyResponse;
    try {
      pubKeys = await uma.fetchPublicKeyForVasp({
        cache: this.pubKeyCache,
        vaspDomain: umaQuery.vaspDomain,
      });
    } catch (e) {
      console.error(e);
      return next(new Error("Failed to fetch public key.", { cause: e }));
    }

    try {
      const isSignatureValid = await uma.verifyUmaLnurlpQuerySignature(
        umaQuery,
        hexToBytes(pubKeys.signingPubKey),
      );
      if (!isSignatureValid) {
        return next(new Error("Invalid UMA query signature."));
      }
    } catch (e) {
      return next(new Error("Invalid UMA query signature.", { cause: e }));
    }

    try {
      const response = await uma.getLnurlpResponse({
        request: umaQuery,
        callback: this.getLnurlpCallback(req, true),
        requiresTravelRuleInfo: true,
        encodedMetadata: this.getEncodedMetadata(req),
        minSendableSats: 1000,
        maxSendableSats: 10000000,
        privateKeyBytes: this.config.umaSigningPrivKey(),
        receiverKycStatus: uma.KycStatus.Verified,
        payerDataOptions: {
          identifier: { mandatory: true },
          name: { mandatory: false },
          email: { mandatory: false },
          compliance: { mandatory: true },
        },
        currencyOptions: [
          {
            symbol: "sat",
            code: "SAT",
            name: "Satoshis",
            maxSendable: 10_000_000_000,
            minSendable: 1,
            multiplier: 1000,
            displayDecimals: 0,
          },
        ],
      });
      res.send(response);
      return "ok";
    } catch (e) {
      console.error(e);
      return next(new Error("Failed to generate UMA response.", { cause: e }));
    }
  }

  private async handleUmaPayreq(req: Request, res: Response, next: any) {
    const uuid = req.params.uuid;
    if (uuid !== this.config.userID) {
      return next(new Error("User not found."));
    }

    let payreq: uma.PayRequest;
    try {
      payreq = uma.parsePayRequest(req.body);
    } catch (e) {
      return next(new Error("Invalid UMA pay request.", { cause: e }));
    }

    let pubKeys: uma.PubKeyResponse;
    try {
      pubKeys = await uma.fetchPublicKeyForVasp({
        cache: this.pubKeyCache,
        vaspDomain: uma.getVaspDomainFromUmaAddress(
          payreq.payerData.identifier,
        ),
      });
    } catch (e) {
      return next(new Error("Failed to fetch public key.", { cause: e }));
    }

    try {
      const isSignatureValid = await uma.verifyPayReqSignature(
        payreq,
        hexToBytes(pubKeys.signingPubKey),
      );
      if (!isSignatureValid) {
        return next(new Error("Invalid payreq signature."));
      }
    } catch (e) {
      return next(new Error("Invalid payreq signature.", { cause: e }));
    }

    if (payreq.currency !== "SAT") {
      return next(new Error("Invalid currency. Only SAT is supported."));
    }

    // In a real implementation for a fiat currency, this come from an exchange rate API.
    const exchangeRateMillisatsToSats = 1000;
    // 3 minutes invoice expiration to avoid big fluctuations in exchange rate.
    const expirationTimeSec = 60 * 3;
    // In a real implementation, this would be the txId for your own internal
    // tracking in post-transaction hooks.
    const txId = "1234";
    const umaInvoiceCreator = {
      createUmaInvoice: async (amountMsats: number, metadata: string) => {
        const invoice = await this.lightsparkClient.createUmaInvoice(
          this.config.nodeID,
          amountMsats,
          metadata,
          expirationTimeSec,
        );
        return invoice?.data.encodedPaymentRequest;
      },
    };

    let response: uma.PayReqResponse;
    try {
      response = await uma.getPayReqResponse({
        conversionRate: exchangeRateMillisatsToSats,
        currencyCode: "SAT",
        invoiceCreator: umaInvoiceCreator,
        metadata: this.getEncodedMetadata(req),
        query: payreq,
        receiverChannelUtxos: [],
        receiverFeesMillisats: 0,
        receiverNodePubKey: await this.getReceiverNodePubKey(),
        utxoCallback: this.getUtxoCallback(req, txId),
      });
      res.send(response);
      return "ok";
    } catch (e) {
      console.error(e);
      return next(new Error("Failed to generate UMA response.", { cause: e }));
    }
  }

  /**
   * Handler for a normal LNURL (non-UMA) LNURLp request.
   */
  private async handleLnurlPayreq(req: Request, res: Response, next: any) {
    const uuid = req.params.uuid;
    if (uuid !== this.config.userID) {
      return next(new Error("User not found."));
    }

    const amountMsats = parseInt(req.query.amount as string);
    if (!amountMsats) {
      res.status(400).send(errorMessage("Missing amount query parameter."));
      return;
    }

    const invoice = await this.lightsparkClient.createLnurlInvoice(
      this.config.nodeID,
      amountMsats,
      this.getEncodedMetadata(req),
    );
    if (!invoice) {
      return next(new Error("Invoice creation failed."));
    }
    res.send({ pr: invoice.data.encodedPaymentRequest, routes: [] });
  }

  private getEncodedMetadata(req: Request): string {
    return JSON.stringify([
      ["text/plain", `Pay ${this.config.username}@${req.hostname}`],
      ["text/identifier", `${this.config.username}@${req.hostname}`],
    ]);
  }

  private getScheme(req: Request): string {
    return req.hostname.startsWith("localhost") ? "http" : "https";
  }

  private getLnurlpCallback(req: Request, isUma: boolean): string {
    const protocol = this.getScheme(req);
    const fullUrl = new URL(req.url, `${protocol}://${req.headers.host}`);
    const port = fullUrl.port;
    const portString =
      port === "80" || port === "443" || port === "" ? "" : `:${port}`;
    const umaOrLnurl = isUma ? "uma" : "lnurl";
    const path = `/api/${umaOrLnurl}/payreq/${this.config.userID}`;
    return `${protocol}://${req.hostname}${portString}${path}`;
  }

  private async getReceiverNodePubKey(): Promise<string> {
    const nodeQuery = getLightsparkNodeQuery(this.config.nodeID);
    let node: LightsparkNode | null;
    try {
      node = await this.lightsparkClient.executeRawQuery(nodeQuery);
    } catch (e) {
      throw new Error(`Failed to fetch node ${this.config.nodeID}.`);
    }
    if (!node) {
      throw new Error(`Node ${this.config.nodeID} not found.`);
    }
    if (!node.publicKey) {
      throw new Error(`Node ${this.config.nodeID} has no known public key.`);
    }
    return node.publicKey;
  }

  private getUtxoCallback(req: Request, txId: String): string {
    const path = `/api/uma/utxoCallback?txId=${txId}`;
    return `${this.getScheme(req)}://${req.hostname}${path}`;
  }
}
