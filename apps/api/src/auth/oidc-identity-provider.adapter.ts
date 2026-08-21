// A-1: OIDC Relying Party adapter — authorization code + PKCE, `state`/`nonce`
// validated, JWKS-verified `id_token` (D-42's OIDC direction). `openid-client`
// is a real, shipping production dependency of apps/api (D-52's blast-radius
// correction) — this file's protocol handling is what the real IdP eventually
// runs against, unchanged; only issuer/client configuration differs.
//
// D-54 — SCOPE BOUNDARY: the local dev IdP this talks to in dev
// (apps/dev-idp) accepts ANY username/password via its devInteractions screen.
// Everything in THIS file is genuinely exercised against that dev IdP —
// discovery, PKCE, `state`, `nonce`, JWKS signature verification — but none of
// it proves a login was legitimately authenticated locally. That guarantee is
// inherited entirely from whichever real IdP D-42's sign-off eventually names.
import * as client from 'openid-client';
import { AuthorizationRequest, IdentityProvider, VerifiedIdentity } from './identity-provider.port';

export interface OidcIdentityProviderConfig {
  issuer: string;
  clientId: string;
  redirectUri: string;
  scope?: string;
  allowInsecureRequests?: boolean; // dev-idp only ever serves plain HTTP locally
}

export class OidcIdentityProviderAdapter implements IdentityProvider {
  private configuration: Promise<client.Configuration> | undefined;

  constructor(private readonly opts: OidcIdentityProviderConfig) {}

  private async getConfiguration(): Promise<client.Configuration> {
    if (!this.configuration) {
      // oauth4webapi does NOT verify an id_token's JWS signature by default
      // for the direct authorization_code token-endpoint exchange — per OIDC
      // Core §3.1.3.7, TLS server validation on a direct client<->AS channel
      // is spec-permitted to substitute for a signature check. That
      // substitution requires an actual TLS-secured channel; local dev talks
      // to dev-idp over plain HTTP (allowInsecureRequests below), so it does
      // not hold here, and the roadmap requires a genuinely JWKS-verified
      // id_token regardless of transport — enableNonRepudiationChecks turns
      // real cryptographic signature verification on unconditionally.
      this.configuration = client.discovery(new URL(this.opts.issuer), this.opts.clientId, undefined, undefined, {
        execute: [
          ...(this.opts.allowInsecureRequests ? [client.allowInsecureRequests] : []),
          client.enableNonRepudiationChecks,
        ],
      });
    }
    return this.configuration;
  }

  async createAuthorizationRequest(): Promise<AuthorizationRequest> {
    const config = await this.getConfiguration();

    const codeVerifier = client.randomPKCECodeVerifier();
    const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
    const state = client.randomState();
    const nonce = client.randomNonce();

    const url = client.buildAuthorizationUrl(config, {
      redirect_uri: this.opts.redirectUri,
      scope: this.opts.scope ?? 'openid',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state,
      nonce,
    });

    return { url: url.href, state, nonce, codeVerifier };
  }

  async completeAuthorizationCodeFlow(input: {
    callbackUrl: URL;
    expectedState: string;
    expectedNonce: string;
    codeVerifier: string;
  }): Promise<VerifiedIdentity> {
    const config = await this.getConfiguration();

    // authorizationCodeGrant validates `state` against expectedState, verifies
    // the id_token's signature via the discovered JWKS, and checks `nonce`
    // against expectedNonce — a mismatch on any of the three throws, it never
    // silently ignores the discrepancy.
    const tokens = await client.authorizationCodeGrant(config, input.callbackUrl, {
      expectedState: input.expectedState,
      expectedNonce: input.expectedNonce,
      pkceCodeVerifier: input.codeVerifier,
      idTokenExpected: true,
    });

    const claims = tokens.claims();
    if (!claims || typeof claims.sub !== 'string') {
      throw new Error('id_token verified but carried no subject claim');
    }

    return { subject: claims.sub, claims: claims as Record<string, unknown> };
  }
}
