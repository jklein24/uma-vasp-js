export type AccessTokenModel = {
    value: string;
    grantId: string;
};

export type AccessTokenStorage = {
    upsertAccessToken(accessToken: AccessTokenModel): Promise<AccessTokenModel>;
    getAccessTokenForGrant(grantId: string): Promise<AccessTokenModel | undefined>;
};