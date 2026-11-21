import { createRemoteJWKSet } from "jose";
import { env } from "./env.js";

export const jwtVerificationConfig = Object.freeze({
  issuer: env.JWT_ISSUER,
  audience: env.JWT_AUDIENCE,
  jwksUrl: new URL(env.JWKS_URL),
});

// Step 04 will consume this cached resolver when the auth middleware is added.
export const remoteJwks = createRemoteJWKSet(jwtVerificationConfig.jwksUrl);
