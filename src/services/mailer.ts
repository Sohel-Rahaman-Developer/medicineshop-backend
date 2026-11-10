import nodemailer, { type Transporter } from 'nodemailer';
import { env, isProd, isSmtpConfigured } from '../config/env';
import { logger } from '../config/logger';
import { isDemoEmail } from '../modules/demo/demo.model';
import { AppError } from '../core/errors';
import { markMail } from './mail-health';
import { signal } from './monitor';

let transporter: Transporter | null = null;

function getTransporter(): Transporter | null {
  if (!isSmtpConfigured) return null;
  if (transporter) return transporter;

  transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE, // 465 → true, 587 → false (STARTTLS)
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
  });

  return transporter;
}

export interface MailInput {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** D114: a payslip PDF; small files only (the queue keeps them in the job). */
  attachments?: { filename: string; contentType: string; content: Buffer }[];
}

export async function sendMail(mail: MailInput): Promise<void> {
  // Demo addresses have no mailbox: a bounce would only hurt how inboxes trust our mail.
  if (isDemoEmail(mail.to)) return;
  const tx = getTransporter();

  if (!tx) {
    if (isProd) {
      throw new Error('SMTP is not configured — email delivery is required in production');
    }
    // Development fallback: print the mail body. The OTP shows up here.
    logger.warn(
      { to: mail.to, subject: mail.subject },
      `\n──── EMAIL (SMTP off, dev fallback) ────\nTo: ${mail.to}\nSubject: ${mail.subject}\n\n${mail.text}\n───────────────────────────────────────\n`,
    );
    return;
  }

  try {
    await tx.sendMail({
      from: `"${env.MAIL_FROM_NAME}" <${env.MAIL_FROM_EMAIL}>`,
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
      ...(mail.attachments?.length ? { attachments: mail.attachments } : {}),
    });
  } catch (err) {
    await markMail(false, err);
    throw err;
  }
  await markMail(true);
}

export const CODE_MAIL_DOWN = 'We could not send the email right now. Please try again in a few minutes.';

/** A sign-in code: a refused send alerts at once and tells the person plainly, instead of "Something went wrong". */
export async function sendCodeMail(mail: MailInput): Promise<void> {
  try {
    await sendMail(mail);
  } catch (err) {
    logger.error({ err }, 'Sign-in code email not sent');
    await signal('code_mail_fail');
    throw AppError.serviceUnavailable(CODE_MAIL_DOWN);
  }
}

/** Checked once at boot so bad SMTP credentials surface at startup. */
export async function verifyMailer(): Promise<boolean> {
  const tx = getTransporter();
  if (!tx) {
    logger.warn('SMTP is not configured — emails will be printed to the console (development only)');
    return false;
  }
  try {
    await tx.verify();
    logger.info('SMTP ready');
    return true;
  } catch (err) {
    logger.error({ err }, 'SMTP verification failed — email will not be delivered');
    return false;
  }
}
