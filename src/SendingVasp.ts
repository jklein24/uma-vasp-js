import { convertCurrencyAmount } from "@lightsparkdev/core";
import {
  CurrencyUnit,
  getLightsparkNodeQuery,
  InvoiceData,
  LightsparkClient,
  OutgoingPayment,
  PaymentDirection,
  TransactionStatus,
} from "@lightsparkdev/lightspark-sdk";
import * as uma from "@uma-sdk/core";
import { getMajorVersion, LnurlpResponse } from "@uma-sdk/core";
import { Express, Request } from "express";
import ComplianceService from "./ComplianceService.js";
import { SATS_CURRENCY } from "./currencies.js";
import InternalLedgerService from "./InternalLedgerService.js";
import {
  fullUrlForRequest,
  hostNameWithPort,
  sendResponse,
} from "./networking/expressAdapters.js";
import { HttpResponse } from "./networking/HttpResponse.js";
import SendingVaspRequestCache, {
  SendingVaspInitialRequestData,
  SendingVaspPayReqData,
} from "./SendingVaspRequestCache.js";
import UmaConfig from "./UmaConfig.js";
import { User } from "./User.js";
import UserService from "./UserService.js";

export default class SendingVasp {
  constructor(
    private readonly config: UmaConfig,
    private readonly lightsparkClient: LightsparkClient,
    private readonly pubKeyCache: uma.PublicKeyCache,
    private readonly requestCache: SendingVaspRequestCache,
    private readonly userService: UserService,
    private readonly ledgerService: InternalLedgerService,
    private readonly complianceService: ComplianceService,
    private readonly nonceCache: uma.NonceValidator,
  ) {}

  registerRoutes(app: Express) {
    app.get("/api/umalookup/:receiver", async (req: Request, resp) => {
      const user = await this.userService.getCallingUserFromRequest(
        fullUrlForRequest(req),
        req.headers,
      );
      if (!user) {
        return sendResponse(resp, {
          httpStatus: 401,
          data: "Unauthorized. Check your credentials.",
        });
      }
      const response = await this.handleClientUmaLookup(
        user,
        req.params.receiver,
        fullUrlForRequest(req),
      );
      sendResponse(resp, response);
    });

    app.get("/api/umapayreq/:callbackUuid", async (req: Request, resp) => {
      const user = await this.userService.getCallingUserFromRequest(
        fullUrlForRequest(req),
        req.headers,
      );
      if (!user) {
        return sendResponse(resp, {
          httpStatus: 401,
          data: "Unauthorized. Check your credentials.",
        });
      }
      const response = await this.handleClientUmaPayreq(
        user,
        req.params.callbackUuid,
        fullUrlForRequest(req),
      );
      sendResponse(resp, response);
    });

    app.post("/api/sendpayment/:callbackUuid", async (req, resp) => {
      const user = await this.userService.getCallingUserFromRequest(
        fullUrlForRequest(req),
        req.headers,
      );
      if (!user) {
        return sendResponse(resp, {
          httpStatus: 401,
          data: "Unauthorized. Check your credentials.",
        });
      }
      const response = await this.handleClientSendPayment(
        user,
        req.params.callbackUuid,
        fullUrlForRequest(req),
      );
      sendResponse(resp, response);
    });
  }

  private async handleClientUmaLookup(
    user: User,
    receiverUmaAddress: string,
    requestUrl: URL,
  ): Promise<HttpResponse> {
    if (!receiverUmaAddress) {
      return { httpStatus: 400, data: "Missing receiver" };
    }

    const [receiverId, receivingVaspDomain] = receiverUmaAddress.split("@");
    if (!receiverId || !receivingVaspDomain) {
      console.error(`Invalid receiver: ${receiverUmaAddress}`);
      return { httpStatus: 400, data: "Invalid receiver" };
    }

    if (
      !this.complianceService.shouldAcceptTransactionToVasp(
        receivingVaspDomain,
        user.umaUserName,
        receiverUmaAddress,
      )
    ) {
      return {
        httpStatus: 400,
        data: `Transaction not allowed to ${receiverUmaAddress}.`,
      };
    }

    const lnurlpRequestUrl = await uma.getSignedLnurlpRequestUrl({
      isSubjectToTravelRule: true,
      receiverAddress: receiverUmaAddress,
      signingPrivateKey: this.config.umaSigningPrivKey(),
      senderVaspDomain: this.getSendingVaspDomain(requestUrl),
    });

    console.log(`Making lnurlp request: ${lnurlpRequestUrl}`);

    let response: globalThis.Response;
    try {
      response = await fetch(lnurlpRequestUrl);
    } catch (e) {
      console.error("Error fetching Lnurlp request.", e);
      return { httpStatus: 424, data: "Error fetching Lnurlp request." };
    }

    if (response.status === 412) {
      try {
        response = await this.retryForUnsupportedVersion(
          response,
          receiverUmaAddress,
          requestUrl,
        );
      } catch (e) {
        console.error("Error fetching Lnurlp request.", e);
        return {
          httpStatus: 424,
          data: new Error("Error fetching Lnurlp request.", { cause: e }),
        };
      }
    }

    if (!response.ok) {
      return {
        httpStatus: 424,
        data: `Error fetching Lnurlp request. ${response.status}`,
      };
    }

    let lnurlpResponse: uma.LnurlpResponse;
    const responseJson = await response.text();
    try {
      lnurlpResponse = uma.LnurlpResponse.fromJson(responseJson);
    } catch (e) {
      console.error("Error parsing lnurlp response.", e, responseJson);
      return { httpStatus: 424, data: `Error parsing Lnurlp response. ${e}` };
    }

    if (!lnurlpResponse.isUma()) {
      console.log("Couldn't parse as uma. Trying raw lnurl.");
      return await this.handleAsNonUmaLnurlpResponse(
        lnurlpResponse,
        receiverId,
        receivingVaspDomain,
      );
    }

    let pubKeys = await this.fetchPubKeys(receivingVaspDomain);
    if (!pubKeys)
      return {
        httpStatus: 424,
        data: "Error fetching receiving vasp public key.",
      };

    try {
      const isSignatureValid = await uma.verifyUmaLnurlpResponseSignature(
        lnurlpResponse,
        pubKeys,
        this.nonceCache,
      );
      if (!isSignatureValid) {
        return { httpStatus: 424, data: "Invalid UMA response signature." };
      }
    } catch (e) {
      console.error("Error verifying UMA response signature.", e);
      return {
        httpStatus: 424,
        data: new Error("Error verifying UMA response signature.", {
          cause: e,
        }),
      };
    }

    const callbackUuid = this.requestCache.saveLnurlpResponseData(
      lnurlpResponse,
      receiverId,
      receivingVaspDomain,
    );

    const senderCurrencies =
      await this.userService.getCurrencyPreferencesForUser(user.id);

    return {
      httpStatus: 200,
      data: {
        senderCurrencies: senderCurrencies ?? [],
        receiverCurrencies: lnurlpResponse.currencies,
        minSendableSats: lnurlpResponse.minSendable,
        maxSendableSats: lnurlpResponse.maxSendable,
        callbackUuid,
        // You might not actually send this to a client in practice.
        receiverKycStatus: lnurlpResponse.compliance.kycStatus,
      },
    };
  }

  private async retryForUnsupportedVersion(
    response: globalThis.Response,
    receiver: string,
    requestUrl: URL,
  ) {
    const responseJson: any = await response.json();
    const supportedMajorVersions = responseJson.supportedMajorVersions;
    const newSupportedVersion = uma.selectHighestSupportedVersion(
      supportedMajorVersions,
    );
    const retryRequest = await uma.getSignedLnurlpRequestUrl({
      isSubjectToTravelRule: true,
      receiverAddress: receiver,
      signingPrivateKey: this.config.umaSigningPrivKey(),
      senderVaspDomain: this.getSendingVaspDomain(requestUrl),
      umaVersionOverride: newSupportedVersion,
    });
    return fetch(retryRequest);
  }

  private async handleAsNonUmaLnurlpResponse(
    lnurlpResponse: LnurlpResponse,
    receiverId: string,
    receivingVaspDomain: string,
  ): Promise<HttpResponse> {
    const callbackUuid = this.requestCache.saveLnurlpResponseData(
      lnurlpResponse,
      receiverId,
      receivingVaspDomain,
    );
    return {
      httpStatus: 200,
      data: {
        receiverCurrencies: lnurlpResponse.currencies || [SATS_CURRENCY],
        callbackUuid: callbackUuid,
        maxSendSats: lnurlpResponse.maxSendable,
        minSendSats: lnurlpResponse.minSendable,
        receiverKycStatus: uma.KycStatus.NotVerified,
      },
    };
  }

  private async handleClientUmaPayreq(
    user: User,
    callbackUuid: string,
    requestUrl: URL,
  ): Promise<HttpResponse> {
    if (!callbackUuid || callbackUuid === "") {
      return { httpStatus: 400, data: "Missing callbackUuid" };
    }

    const initialRequestData =
      this.requestCache.getLnurlpResponseData(callbackUuid);
    if (!initialRequestData) {
      return { httpStatus: 400, data: "callbackUuid not found" };
    }

    const amountStr = requestUrl.searchParams.get("amount");
    if (!amountStr || typeof amountStr !== "string") {
      return { httpStatus: 400, data: "Missing amount" };
    }
    const amount = parseFloat(amountStr);
    if (isNaN(amount)) {
      return { httpStatus: 400, data: "Invalid amount" };
    }

    if (!initialRequestData.lnurlpResponse) {
      return { httpStatus: 400, data: "Invalid callbackUuid" };
    }
    const receivingCurrencyCode = requestUrl.searchParams.get(
      "receivingCurrencyCode",
    );
    const isUma = initialRequestData.lnurlpResponse.isUma();

    const payerProfile = this.getPayerProfile(
      user,
      initialRequestData.lnurlpResponse.payerData!,
      this.getSendingVaspDomain(requestUrl),
      isUma,
    );

    if (!isUma) {
      const msatsParam = requestUrl.searchParams.get("isAmountInMsats");
      return await this.handleNonUmaPayReq(
        initialRequestData,
        amount,
        payerProfile,
        msatsParam,
        receivingCurrencyCode,
      );
    }

    if (!receivingCurrencyCode || typeof receivingCurrencyCode !== "string") {
      return { httpStatus: 400, data: "Missing currencyCode" };
    }
    const selectedCurrency = (
      initialRequestData.lnurlpResponse.currencies || []
    ).find((c) => c.code === receivingCurrencyCode);
    if (selectedCurrency === undefined) {
      return { httpStatus: 400, data: "Currency code not supported" };
    }

    const msatsParam = requestUrl.searchParams.get("isAmountInMsats");
    const isAmountInMsats = msatsParam?.toLocaleLowerCase() === "true";
    const amountValueMillisats = isAmountInMsats
      ? amount
      : selectedCurrency.multiplier * amount;
    const sendingCurrencyCode =
      requestUrl.searchParams.get("sendingCurrency") ?? "SAT";
    const sendingCurrency = (
      await this.userService.getCurrencyPreferencesForUser(user.id)
    )?.find((c) => c.code === sendingCurrencyCode);
    if (sendingCurrency === undefined) {
      return { httpStatus: 400, data: "Sending currency code not supported" };
    }
    const sendingCurrencyAmount =
      amountValueMillisats / sendingCurrency.multiplier;

    if (
      !this.checkInternalLedgerBalance(
        user.id,
        amountValueMillisats,
        sendingCurrencyAmount,
        sendingCurrencyCode,
      )
    ) {
      return { httpStatus: 400, data: "Insufficient balance." };
    }

    let pubKeys = await this.fetchPubKeys(
      initialRequestData.receivingVaspDomain,
    );
    if (!pubKeys) {
      return {
        httpStatus: 424,
        data: "Error fetching receiving vasp public key.",
      };
    }

    const trInfo = await this.complianceService.getTravelRuleInfoForTransaction(
      user.id,
      payerProfile.identifier!,
      `${initialRequestData.receiverId}@${initialRequestData.receivingVaspDomain}`,
      amountValueMillisats,
    );
    const node = await this.getLightsparkNode();
    const utxoCallback = this.getUtxoCallback(requestUrl, "1234abcd");

    console.log(`Generating payreq for ${amountValueMillisats} msats.`);
    console.log(`  isAmountInMsats: ${isAmountInMsats}`);
    console.log(`  amount: ${amount}`);
    let payReq: uma.PayRequest;
    try {
      payReq = await uma.getPayRequest({
        receiverEncryptionPubKey: pubKeys.getEncryptionPubKey(),
        sendingVaspPrivateKey: this.config.umaSigningPrivKey(),
        receivingCurrencyCode: receivingCurrencyCode,
        isAmountInReceivingCurrency: !isAmountInMsats,
        amount: amount,
        payerIdentifier: payerProfile.identifier!,
        payerKycStatus: user.kycStatus,
        utxoCallback,
        trInfo,
        payerUtxos: node.umaPrescreeningUtxos,
        payerNodePubKey: node.publicKey ?? "",
        payerName: payerProfile.name,
        payerEmail: payerProfile.email,
        requestedPayeeData: {
          // Compliance and Identifier are mandatory fields added automatically.
          name: { mandatory: false },
          email: { mandatory: false },
        },
        umaMajorVersion: initialRequestData.lnurlpResponse.umaVersion
          ? getMajorVersion(initialRequestData.lnurlpResponse.umaVersion)
          : 1,
      });
    } catch (e) {
      console.error("Error generating payreq.", e);
      return { httpStatus: 500, data: "Error generating payreq." };
    }

    console.log(
      `Sending payreq: ${JSON.stringify(payReq.toJsonSchemaObject(), null, 2)}`,
    );
    let response: globalThis.Response;
    try {
      response = await fetch(initialRequestData.lnurlpResponse.callback, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: payReq.toJsonString(),
      });
    } catch (e) {
      return { httpStatus: 500, data: "Error sending payreq." };
    }

    if (!response.ok || response.status !== 200) {
      return { httpStatus: 424, data: `Payreq failed. ${response.status}` };
    }

    let payResponse: uma.PayReqResponse;
    const bodyText = await response.text();
    try {
      payResponse = await uma.PayReqResponse.fromJson(bodyText);
    } catch (e) {
      console.error("Error parsing payreq response. Raw response: " + bodyText);
      console.error("Error:", e);
      return { httpStatus: 424, data: "Error parsing payreq response." };
    }

    if (!payResponse.isUma()) {
      console.log("Received non-uma response for uma payreq.");
      return {
        httpStatus: 424,
        data: "Received non-uma response for uma payreq.",
      };
    }

    try {
      if (payReq.umaMajorVersion !== 0) {
        const isSignatureValid = await uma.verifyPayReqResponseSignature(
          payResponse,
          payerProfile.identifier!,
          `${initialRequestData.receiverId}@${initialRequestData.receivingVaspDomain}`,
          pubKeys,
          this.nonceCache,
        );
        if (!isSignatureValid) {
          return {
            httpStatus: 424,
            data: "Invalid payreq response signature.",
          };
        }
      }
    } catch (e) {
      console.error(e);
      return {
        httpStatus: 424,
        data: new Error("Invalid payreq response signature.", { cause: e }),
      };
    }

    console.log(`Verified payreq response signature.`);

    const shouldTransact = await this.complianceService.preScreenTransaction(
      payerProfile.identifier!,
      `${initialRequestData.receiverId}@${initialRequestData.receivingVaspDomain}`,
      amountValueMillisats,
      payResponse.payeeData?.compliance?.nodePubKey ?? undefined,
      payResponse.payeeData?.compliance?.utxos ?? [],
    );
    if (!shouldTransact) {
      return {
        httpStatus: 424,
        data: "Transaction not allowed due to risk rating.",
      };
    }

    let invoice: InvoiceData;
    try {
      invoice = await this.lightsparkClient.decodeInvoice(payResponse.pr);
    } catch (e) {
      console.error("Error decoding invoice.", e);
      return { httpStatus: 500, data: "Error decoding invoice." };
    }

    const senderCurrencies =
      (await this.userService.getCurrencyPreferencesForUser(user.id)) ?? [];

    const newCallbackUuid = this.requestCache.savePayReqData(
      payerProfile.identifier!,
      payResponse.pr,
      utxoCallback,
      invoice,
      senderCurrencies,
    );

    const amountMsats = convertCurrencyAmount(
      invoice.amount,
      CurrencyUnit.MILLISATOSHI,
    ).preferredCurrencyValueRounded;

    return {
      httpStatus: 200,
      data: {
        senderCurrencies: senderCurrencies ?? [],
        callbackUuid: newCallbackUuid,
        encodedInvoice: payResponse.pr,
        amountMsats: amountMsats,
        amountReceivingCurrency: payResponse.converted!.amount,
        conversionRate: payResponse.converted!.multiplier,
        exchangeFeesMsats: payResponse.converted!.fee,
        receivingCurrencyCode: payResponse.converted!.currencyCode,
      },
    };
  }

  private async handleNonUmaPayReq(
    initialRequestData: SendingVaspInitialRequestData,
    amount: number,
    payerProfile: PayerProfile,
    sendingCurrencyCode: string | null,
    receivingCurrencyCode: string | null,
  ): Promise<HttpResponse> {
    let response: globalThis.Response;
    try {
      const url = new URL(initialRequestData.lnurlpResponse.callback);
      if (sendingCurrencyCode) {
        url.searchParams.append("amount", `${amount}.${sendingCurrencyCode}`);
      } else {
        url.searchParams.append("amount", amount.toString());
      }
      if (receivingCurrencyCode) {
        url.searchParams.append("convert", receivingCurrencyCode);
      }
      if (payerProfile.identifier || payerProfile.email || payerProfile.name) {
        url.searchParams.append("payerdata", JSON.stringify(payerProfile));
      }
      response = await fetch(url.toString(), {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
        },
      });
    } catch (e) {
      console.error("Error sending payreq.", e);
      return { httpStatus: 500, data: "Error sending payreq." };
    }

    const responseText = await response.text();
    if (!response.ok) {
      return { httpStatus: 424, data: `Payreq failed. ${response.status}` };
    }

    const responseJson = JSON.parse(responseText);
    if (responseJson.status === "ERROR") {
      console.error("Error on pay request.", responseJson.reason);
      return {
        httpStatus: 424,
        data: `Error on pay request. reason: ${responseJson.reason}`,
      };
    }
    let payreqResponse: uma.PayReqResponse;
    try {
      payreqResponse = uma.PayReqResponse.fromJson(responseText);
    } catch (e) {
      console.error("Error parsing payreq response.", e);
      return { httpStatus: 424, data: "Error parsing payreq response." };
    }

    const encodedInvoice = payreqResponse.pr;

    let invoice: InvoiceData;
    try {
      invoice = await this.lightsparkClient.decodeInvoice(encodedInvoice);
    } catch (e) {
      console.error("Error decoding invoice.", e);
      return { httpStatus: 500, data: "Error decoding invoice." };
    }

    const newCallbackUuid = this.requestCache.savePayReqData(
      payreqResponse.payeeData?.identifier ?? "",
      encodedInvoice,
      "", // No utxo callback for non-UMA lnurl.
      invoice,
      [],
    );

    return {
      httpStatus: 200,
      data: {
        callbackUuid: newCallbackUuid,
        encodedInvoice: encodedInvoice,
        amount: payreqResponse.converted?.amount ?? invoice.amount,
        conversionRate: payreqResponse.converted?.multiplier ?? 1000,
        exchangeFeesMillisatoshi: payreqResponse.converted?.fee ?? 0,
        currencyCode: receivingCurrencyCode ?? "SAT",
      },
    };
  }

  private async getLightsparkNode() {
    const node = await this.lightsparkClient.executeRawQuery(
      getLightsparkNodeQuery(this.config.nodeID),
    );
    if (!node) {
      throw new Error("Node not found.");
    }

    return node;
  }

  private async fetchPubKeys(receivingVaspDomain: string) {
    try {
      return await uma.fetchPublicKeyForVasp({
        cache: this.pubKeyCache,
        vaspDomain: receivingVaspDomain,
      });
    } catch (e) {
      console.error("Error fetching public key.", e);
      return null;
    }
  }

  private async handleClientSendPayment(
    user: User,
    callbackUuid: string,
    requestUrl: URL,
  ): Promise<HttpResponse> {
    if (!callbackUuid || callbackUuid === "") {
      return { httpStatus: 400, data: "Missing callbackUuid" };
    }

    const payReqData = this.requestCache.getPayReqData(callbackUuid);
    if (!payReqData) {
      return { httpStatus: 400, data: "callbackUuid not found" };
    }

    if (new Date(payReqData.invoiceData.expiresAt) < new Date()) {
      return { httpStatus: 400, data: "Invoice expired" };
    }

    if (payReqData.invoiceData.amount.originalValue <= 0) {
      return {
        httpStatus: 400,
        data: "Invalid invoice amount. Positive amount required.",
      };
    }

    const sendingCurrencyCode =
      requestUrl.searchParams.get("sendingCurrency") ?? "SAT";
    const sendingCurrency = (
      await this.userService.getCurrencyPreferencesForUser(user.id)
    )?.find((c) => c.code === sendingCurrencyCode);
    if (sendingCurrency === undefined) {
      return { httpStatus: 400, data: "Sending currency code not supported" };
    }

    const amountMsats = convertCurrencyAmount(
      payReqData.invoiceData.amount,
      CurrencyUnit.MILLISATOSHI,
    ).preferredCurrencyValueRounded;

    const sendingCurrencyAmount = amountMsats / sendingCurrency.multiplier;
    if (sendingCurrencyAmount < sendingCurrency.minSendable) {
      return {
        httpStatus: 400,
        data: `Invalid invoice amount. Minimum amount is ${sendingCurrency.minSendable} ${sendingCurrency.code}.`,
      };
    }
    if (sendingCurrencyAmount > sendingCurrency.maxSendable) {
      return {
        httpStatus: 400,
        data: `Invalid invoice amount. Maximum amount is ${sendingCurrency.maxSendable} ${sendingCurrency.code}.`,
      };
    }

    if (
      !this.checkInternalLedgerBalance(
        user.id,
        amountMsats,
        sendingCurrencyAmount,
        sendingCurrencyCode,
      )
    ) {
      return { httpStatus: 400, data: "Insufficient balance." };
    }

    let payment: OutgoingPayment;
    let paymentId: string | undefined = undefined;
    try {
      const signingKeyLoaded = await this.loadNodeSigningKey();
      if (!signingKeyLoaded) {
        throw new Error("Error loading signing key.");
      }
      const paymentResult = await this.lightsparkClient.payUmaInvoice(
        this.config.nodeID,
        payReqData.encodedInvoice,
        /* maxFeesMsats */ 1_000_000,
      );
      if (!paymentResult) {
        throw new Error("Payment request failed.");
      }
      paymentId = paymentResult.id;
      await this.ledgerService.recordOutgoingTransactionBegan(
        user.id,
        payReqData.receiverUmaAddress,
        amountMsats,
        sendingCurrencyAmount,
        sendingCurrency.code,
        paymentId!,
      );
      payment = await this.waitForPaymentCompletion(paymentResult);
      await this.ledgerService.recordOutgoingTransactionSucceeded(
        user.id,
        payReqData.receiverUmaAddress,
        amountMsats,
        sendingCurrencyAmount,
        sendingCurrency.code,
        paymentId!,
      );
    } catch (e) {
      console.error("Error paying invoice.", e);
      if (paymentId !== undefined) {
        await this.ledgerService.recordOutgoingTransactionFailed(
          user.id,
          payReqData.receiverUmaAddress,
          amountMsats,
          sendingCurrencyAmount,
          sendingCurrency.code,
          paymentId,
        );
      }
      return { httpStatus: 500, data: "Error paying invoice." };
    }

    await this.sendPostTransactionCallback(payment, payReqData, requestUrl);

    const nodePubKey = (await this.getLightsparkNode()).publicKey;
    await this.complianceService.registerTransactionMonitoring(
      payment.id,
      nodePubKey,
      PaymentDirection.SENT,
      payment.umaPostTransactionData ?? [],
    );

    return {
      httpStatus: 200,
      data: {
        paymentId: payment.id,
        didSucceed: payment.status === TransactionStatus.SUCCESS,
      },
    };
  }

  private async checkInternalLedgerBalance(
    userId: string,
    amountMsats: number,
    sendingCurrencyAmount: number,
    sendingCurrencyCode: string,
  ): Promise<boolean> {
    const balanceMsats = await this.ledgerService.getUserBalance(
      userId,
      sendingCurrencyCode,
    );
    return balanceMsats >= sendingCurrencyAmount;
  }

  /**
   * NOTE: In a real application, you'd want to use the authentication context to pull out this information. It's not
   * actually always Alice sending the money ;-).
   */
  private getPayerProfile(
    user: User,
    requiredPayerData: uma.CounterPartyDataOptions,
    vaspDomain: string,
    isUma: boolean,
  ): PayerProfile {
    return {
      name: requiredPayerData.name?.mandatory ? user.name ?? "" : undefined,
      email: requiredPayerData.email?.mandatory
        ? user.emailAddress ?? ""
        : undefined,
      identifier:
        isUma || !!requiredPayerData.identifier
          ? `$${user.umaUserName}@${vaspDomain}`
          : undefined,
    };
  }

  private getUtxoCallback(requestUrl: URL, txId: String): string {
    const path = `/api/uma/utxoCallback?txId=${txId}`;
    return `${requestUrl.protocol}//${requestUrl.hostname}${path}`;
  }

  private async waitForPaymentCompletion(
    paymentResult: OutgoingPayment,
    retryNum = 0,
  ): Promise<OutgoingPayment> {
    if (paymentResult.status === TransactionStatus.SUCCESS) {
      return paymentResult;
    }

    const payment = await this.lightsparkClient.executeRawQuery(
      OutgoingPayment.getOutgoingPaymentQuery(paymentResult.id),
    );
    if (!payment) {
      throw new Error("Payment not found.");
    }

    if (payment.status !== TransactionStatus.PENDING) {
      return payment;
    }

    const maxRetries = 40;
    if (retryNum >= maxRetries) {
      throw new Error("Payment timed out.");
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
    return this.waitForPaymentCompletion(payment);
  }

  private async sendPostTransactionCallback(
    payment: OutgoingPayment,
    payReqData: SendingVaspPayReqData,
    requestUrl: URL,
  ) {
    if (!payReqData.utxoCallback || payReqData.utxoCallback === "") {
      return;
    }
    const utxos: uma.UtxoWithAmount[] =
      payment.umaPostTransactionData?.map((d) => {
        return {
          utxo: d.utxo,
          amount: convertCurrencyAmount(d.amount, CurrencyUnit.MILLISATOSHI)
            .preferredCurrencyValueRounded,
        };
      }) ?? [];
    const postTransactionCallback = await uma.getPostTransactionCallback({
      utxos: utxos,
      vaspDomain: this.getSendingVaspDomain(requestUrl),
      signingPrivateKey: this.config.umaSigningPrivKey(),
    });
    try {
      const postTxResponse = await fetch(payReqData.utxoCallback, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(postTransactionCallback),
      });
      if (!postTxResponse.ok) {
        console.error(
          `Error sending post transaction callback. ${postTxResponse.status}`,
        );
      }
    } catch (e) {
      console.error("Error sending post transaction callback.", e);
    }
  }

  private async loadNodeSigningKey(): Promise<boolean> {
    const node = await this.lightsparkClient.executeRawQuery(
      getLightsparkNodeQuery(this.config.nodeID),
    );
    if (!node) {
      throw new Error("Node not found.");
    }

    if (node.typename.includes("OSK")) {
      if (
        !this.config.oskSigningKeyPassword ||
        this.config.oskSigningKeyPassword === ""
      ) {
        throw new Error(
          "Node is an OSK, but no signing key password was provided in the config. " +
            "Set the LIGHTSPARK_UMA_OSK_NODE_SIGNING_KEY_PASSWORD environment variable",
        );
      }
      return await this.lightsparkClient.loadNodeSigningKey(
        this.config.nodeID,
        {
          password: this.config.oskSigningKeyPassword,
        },
      );
    }

    // Assume remote signing node.
    const remoteSigningMasterSeed = this.config.remoteSigningMasterSeed();
    if (!remoteSigningMasterSeed) {
      throw new Error(
        "Node is a remote signing node, but no master seed was provided in the config. " +
          "Set the LIGHTSPARK_UMA_REMOTE_SIGNING_NODE_MASTER_SEED environment variable",
      );
    }
    return await this.lightsparkClient.loadNodeSigningKey(this.config.nodeID, {
      masterSeed: remoteSigningMasterSeed,
      network: node.bitcoinNetwork,
    });
  }

  private getSendingVaspDomain(requestUrl: URL): string {
    const configVaspDomain = this.config.sendingVaspDomain;
    if (configVaspDomain) {
      return configVaspDomain;
    }
    return hostNameWithPort(requestUrl);
  }
}

type PayerProfile = {
  name?: string | undefined;
  email?: string | undefined;
  identifier?: string | undefined;
};
