import nodemailer from 'nodemailer';
import { Resend } from 'resend';
import ConnectorSettings from '../models/ConnectorSettings.js';
import { decrypt } from './cryptoService.js';

const CACHE_TTL_MS = 60 * 1000;
let cache = { value: null, expiresAt: 0 };

export function invalidateEmailConfigCache() {
  cache = { value: null, expiresAt: 0 };
}

// Résout la config email (DB si activée, sinon repli sur les variables d'env)
// et construit le transporteur/client correspondant. Mis en cache 60s pour
// éviter de recréer un transporteur SMTP à chaque envoi.
export async function getEmailContext() {
  if (cache.expiresAt > Date.now()) return cache.value;

  let cfg = {
    provider: (process.env.EMAIL_PROVIDER || 'smtp').toLowerCase(),
    smtpHost: process.env.SMTP_HOST || '',
    smtpPort: parseInt(process.env.SMTP_PORT, 10) || 465,
    smtpSecure: process.env.SMTP_SECURE === 'true',
    smtpUser: process.env.SMTP_USER || '',
    smtpPassword: process.env.SMTP_PASSWORD || '',
    resendApiKey: process.env.RESEND_API_KEY || '',
    fromAddress: process.env.EMAIL_FROM_ADDRESS || 'noreply@example.com',
    fromName: process.env.EMAIL_FROM_NAME || 'EbookRequest',
  };

  try {
    const doc = await ConnectorSettings.findOne({ service: 'emailProvider' }).lean();
    if (doc?.enabled && doc?.provider) {
      const secret = doc.apiKey ? (decrypt(doc.apiKey) ?? doc.apiKey) : '';
      cfg = {
        provider: doc.provider,
        smtpHost: doc.provider === 'smtp' ? (doc.smtpHost || cfg.smtpHost) : cfg.smtpHost,
        smtpPort: doc.provider === 'smtp' ? (doc.smtpPort || cfg.smtpPort) : cfg.smtpPort,
        smtpSecure: doc.provider === 'smtp' ? (doc.smtpSecure ?? cfg.smtpSecure) : cfg.smtpSecure,
        smtpUser: doc.provider === 'smtp' ? (doc.username || cfg.smtpUser) : cfg.smtpUser,
        smtpPassword: doc.provider === 'smtp' ? (secret || cfg.smtpPassword) : cfg.smtpPassword,
        resendApiKey: doc.provider === 'resend' ? (secret || cfg.resendApiKey) : cfg.resendApiKey,
        fromAddress: doc.fromAddress || cfg.fromAddress,
        fromName: doc.fromName || cfg.fromName,
      };
    }
  } catch {
    // MongoDB indisponible → on garde le fallback env
  }

  let transporter = null;
  let resendClient = null;

  if (cfg.provider === 'resend') {
    if (cfg.resendApiKey) resendClient = new Resend(cfg.resendApiKey);
  } else {
    transporter = nodemailer.createTransport({
      host: cfg.smtpHost,
      port: cfg.smtpPort,
      secure: cfg.smtpSecure,
      auth: { user: cfg.smtpUser, pass: cfg.smtpPassword },
      tls: { rejectUnauthorized: false },
    });
  }

  const context = {
    cfg,
    transporter,
    resendClient,
    from: `"${cfg.fromName}" <${cfg.fromAddress}>`,
  };

  cache = { value: context, expiresAt: Date.now() + CACHE_TTL_MS };
  return context;
}
