import { JWK, UnauthenticatedClient } from "@interledger/open-payments";

export interface ClientKey {
  jwk: JWK;
  client: ClientDetails;
}

interface ClientDetails {
  // id: string
  name: string;
  // image: string
  uri: string;
  // email: string
}

export interface KeyOptions {
  client: string;
  keyId: string;
}

export default class ClientAppHelper {
  constructor(private readonly openPaymentsClient: UnauthenticatedClient) {}

  async getClient(client: string): Promise<ClientDetails | undefined> {
    try {
      const walletAddress = await this.openPaymentsClient.walletAddress.get({
        url: client,
      });
      if (!walletAddress.publicName) {
        console.warn("Wallet address does not have a public name.");
        return;
      }
      return {
        name: walletAddress.publicName,
        uri: client,
      };
    } catch (error) {
      console.error(
        {
          error,
          client,
        },
        "retrieving client display info",
      );
      return undefined;
    }
  }

  async getClientKey({ client, keyId }: KeyOptions): Promise<JWK | undefined> {
    try {
      const { keys } = await this.openPaymentsClient.walletAddress.getKeys({
        url: client,
      });

      return keys.find((key: JWK) => key.kid === keyId);
    } catch (error) {
      console.debug(
        {
          error,
          client,
        },
        "retrieving client key",
      );
      return undefined;
    }
  }
}
