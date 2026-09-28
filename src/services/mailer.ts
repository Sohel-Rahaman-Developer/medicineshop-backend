/**
 * SMTP mailer.
 *
 * When SMTP is not configured (common in development) the mail is printed to
 * the console instead of being sent, so OTP login can be tested without a mail
 * server. In production, missing SMTP throws — silently not sending email
 * there would be a serious bug.
 */
import nodemailer, { type Transporter } from 'nodemailer';
import { env, isProd, isSmtpConfigured } from '../config/env';
import { logger } from '../config/logger';

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
}

export async function sendMail(mail: MailInput): Promise<void> {
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

  await tx.sendMail({
    from: `"${env.MAIL_FROM_NAME}" <${env.MAIL_FROM_EMAIL}>`,
    to: mail.to,
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
  });
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
