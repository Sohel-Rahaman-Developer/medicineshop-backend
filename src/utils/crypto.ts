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

export function newFamilyId(): string {
  return crypto.randomUUID();
}
