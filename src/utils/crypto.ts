/**
 * Crypto helpers — OTP hashing and opaque token generation.
 *
 * Rule: OTPs and refresh tokens never reach the database in plain text.
 *  - OTP      → bcrypt (a slow hash, because a 6-digit space is tiny)
 *  - Refresh  → SHA-256 (the token is already 256 bits of randomness, so a
 *               slow KDF buys nothing — brute force is not possible)
 */
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';

const OTP_SALT_ROUNDS = 10;

/** Cryptographically secure N-digit OTP. Never use Math.random() for this. */
export function generateNumericOtp(length: number): string {
  let otp = '';
  for (let i = 0; i < length; i++) otp += crypto.randomInt(0, 10).toString();
  return otp;
}

export function hashOtp(otp: string): Promise<string> {
  return bcrypt.hash(otp, OTP_SALT_ROUNDS);
}

export function compareOtp(otp: string, hash: string): Promise<boolean> {
  return bcrypt.compare(otp, hash);
}

/** 256-bit random token, used for refresh tokens. */
export function generateOpaqueToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

/**
 * Identifier for the chain of refresh tokens that starts at one login.
 * When reuse is detected, the whole family is revoked together.
 */
export function newFamilyId(): string {
  return crypto.randomUUID();
}
