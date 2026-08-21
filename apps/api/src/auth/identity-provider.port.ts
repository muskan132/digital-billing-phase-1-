// A-1: the seam the rest of apps/api depends on. No concrete OIDC library
// type crosses this boundary — a future real IdP swap (D-42's open sign-off)
// changes only the adapter that implements this, never a caller.

export interface AuthorizationRequest {
  url: string;
  state: string;
  nonce: string;
  codeVerifier: string;
}

export interface VerifiedIdentity {
  subject: string;
  claims: Record<string, unknown>;
}

export interface IdentityProvider {
  createAuthorizationRequest(): Promise<AuthorizationRequest>;

  completeAuthorizationCodeFlow(input: {
    callbackUrl: URL;
    expectedState: string;
    expectedNonce: string;
    codeVerifier: string;
  }): Promise<VerifiedIdentity>;
}
