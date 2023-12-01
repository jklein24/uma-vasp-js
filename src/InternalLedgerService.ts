export default interface InternalLedgerService {
  recordOutgoingTransactionBegan(
    userId: string,
    receivingUmaAddress: string,
    amountMsats: number,
    lightsparkTransactionId: string,
  ): Promise<void>;
  recordOutgoingTransactionSucceeded(
    userId: string,
    receivingUmaAddress: string,
    amountMsats: number,
    lightsparkTransactionId: string,
  ): Promise<void>;
  recordOutgoingTransactionFailed(
    userId: string,
    receivingUmaAddress: string,
    amountMsats: number,
    lightsparkTransactionId: string,
  ): Promise<void>;
  recordReceivedTransaction(
    userId: string,
    sendingUmaAddress: string,
    amountMsats: number,
    lightsparkTransactionId: string,
  ): Promise<void>;
  changeUserBalance(userId: string, amountDeltaMsats: number): Promise<void>;
  getUserBalanceMsats(userId: string): Promise<number>;
}
