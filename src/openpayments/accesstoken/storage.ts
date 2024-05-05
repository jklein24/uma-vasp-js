export type AccessTokenModel = {
  value: string;
  grantId: string;
  createdAt: Date;
  expiresIn: number;
};

export interface AccessTokenStorage {
  upsertAccessToken(accessToken: AccessTokenModel): Promise<AccessTokenModel>;
  getByValue(tokenValue: string): Promise<AccessTokenModel | undefined>;
  getAccessTokenForGrant(
    grantId: string,
  ): Promise<AccessTokenModel | undefined>;
  delete(tokenValue: string): Promise<AccessTokenModel | undefined>;
}

export class InMemoryAccessTokenStorage implements AccessTokenStorage {
  private tokens: Record<string, AccessTokenModel> = {};
  private tokensByGrant: Record<string, AccessTokenModel> = {};
  private static instance: InMemoryAccessTokenStorage;

  private constructor() {}

  static getInstance(): InMemoryAccessTokenStorage {
    if (!InMemoryAccessTokenStorage.instance) {
      InMemoryAccessTokenStorage.instance = new InMemoryAccessTokenStorage();
    }
    return InMemoryAccessTokenStorage.instance;
  }

  async upsertAccessToken(
    accessToken: AccessTokenModel,
  ): Promise<AccessTokenModel> {
    this.tokens[accessToken.value] = accessToken;
    this.tokensByGrant[accessToken.grantId] = accessToken;
    return accessToken;
  }

  async getByValue(tokenValue: string): Promise<AccessTokenModel | undefined> {
    return this.tokens[tokenValue];
  }

  async getAccessTokenForGrant(
    grantId: string,
  ): Promise<AccessTokenModel | undefined> {
    return this.tokensByGrant[grantId];
  }

  async delete(tokenValue: string): Promise<AccessTokenModel | undefined> {
    const token = this.tokens[tokenValue];
    delete this.tokens[tokenValue];
    delete this.tokensByGrant[token.grantId];
    return token;
  }
}
