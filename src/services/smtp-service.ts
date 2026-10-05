import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { ImapAccount, EmailComposer, SmtpConfig } from '../types/index.js';
import { getAccessToken } from './oauth-service.js';

// Delai par socket SMTP : un serveur qui ne repond pas en une minute ne repondra pas.
const SMTP_SOCKET_TIMEOUT_MS = Number(process.env.SMTP_SOCKET_TIMEOUT_MS ?? 60000);

interface CachedTransporter {
  transporter: nodemailer.Transporter;
  // Le jeton OAuth2 avec lequel le transporteur a ete construit : un jeton
  // renouvele vaut un transporteur neuf, pas une reconnexion sur l'ancien.
  accessToken?: string;
}

export class SmtpService {
  private transporters: Map<string, CachedTransporter> = new Map();

  /**
   * Un transporteur par compte, en POOL (une connexion gardee ouverte entre deux
   * envois, refermee seule apres inactivite). Jusqu'au 05/10/2026 : TCP + TLS + AUTH
   * par envoi, un `verify()` de plus a la creation (donc deux connexions pour un
   * message), et jamais de cache pour les comptes OAuth2.
   */
  async createTransporter(account: ImapAccount): Promise<nodemailer.Transporter> {
    const accessToken = account.oauth2 ? await getAccessToken(account) : undefined;
    const cached = this.transporters.get(account.id);
    if (cached && cached.accessToken === accessToken) {
      return cached.transporter;
    }
    if (cached) {
      try { cached.transporter.close(); } catch { /* deja ferme */ }
      this.transporters.delete(account.id);
    }

    const smtpConfig = account.smtp || this.getDefaultSmtpConfig(account);
    const { secure, requireTLS } = this.resolveTlsMode(smtpConfig.port, smtpConfig.secure);

    const transporterOptions = {
      pool: true as const,
      maxConnections: 1,
      maxMessages: 100,
      socketTimeout: SMTP_SOCKET_TIMEOUT_MS,
      host: smtpConfig.host,
      port: smtpConfig.port,
      secure,
      requireTLS,
      auth: account.oauth2
        ? { type: 'OAuth2' as const, user: smtpConfig.user || account.user, accessToken }
        : {
            user: smtpConfig.user || account.user,
            pass: smtpConfig.password || account.password,
          },
      tls: smtpConfig.tls,
    };

    const transporter = nodemailer.createTransport(transporterOptions);
    this.transporters.set(account.id, { transporter, accessToken });
    return transporter;
  }

  // Port 465 is implicit TLS (SMTPS); 587/25 are submission ports that upgrade via STARTTLS.
  // A stored `secure: true` on port 587 is almost always a UI mistake — normalize it.
  private resolveTlsMode(port: number, secure: boolean): { secure: boolean; requireTLS: boolean } {
    if (port === 465) return { secure: true, requireTLS: false };
    if (port === 587 || port === 25) return { secure: false, requireTLS: true };
    return { secure, requireTLS: !secure };
  }

  private getDefaultSmtpConfig(account: ImapAccount): SmtpConfig {
    // Common SMTP configurations based on IMAP settings
    const commonProviders: { [key: string]: SmtpConfig } = {
      'imap.gmail.com': {
        host: 'smtp.gmail.com',
        port: 587,
        secure: false,
      },
      'outlook.office365.com': {
        host: 'smtp.office365.com',
        port: 587,
        secure: false,
      },
      'imap-mail.outlook.com': {
        host: 'smtp-mail.outlook.com',
        port: 587,
        secure: false,
      },
      'imap.mail.yahoo.com': {
        host: 'smtp.mail.yahoo.com',
        port: 587,
        secure: false,
      },
      'imap.aol.com': {
        host: 'smtp.aol.com',
        port: 587,
        secure: false,
      },
      'imap.fastmail.com': {
        host: 'smtp.fastmail.com',
        port: 587,
        secure: false,
      },
      'imap.zoho.com': {
        host: 'smtp.zoho.com',
        port: 465,
        secure: true,
      },
      'imappro.zoho.com': {
        host: 'smtppro.zoho.com',
        port: 465,
        secure: true,
      },
    };

    const providerConfig = commonProviders[account.host];
    if (providerConfig) {
      return providerConfig;
    }

    // Default: submission port 587 with STARTTLS (RFC 8314 recommended).
    // Guess SMTP host: rewrite imap.* to smtp.* if present, otherwise reuse the IMAP host.
    const smtpHost = account.host.startsWith('imap.') || account.host.startsWith('imap-')
      ? account.host.replace(/^imap[.-]/, (m) => m === 'imap.' ? 'smtp.' : 'smtp-')
      : account.host;
    return {
      host: smtpHost,
      port: 587,
      secure: false,
    };
  }

  private toMailOptions(account: ImapAccount, email: EmailComposer): nodemailer.SendMailOptions {
    return {
      from: email.from || account.email || account.user,
      to: email.to,
      cc: email.cc,
      bcc: email.bcc,
      subject: email.subject,
      text: email.text,
      html: email.html,
      attachments: email.attachments?.map(att => ({
        filename: att.filename,
        content: att.content,
        path: att.path,
        contentType: att.contentType,
        contentDisposition: att.contentDisposition,
        cid: att.cid,
      })),
      replyTo: email.replyTo,
      inReplyTo: email.inReplyTo,
      references: Array.isArray(email.references) ? email.references.join(' ') : email.references,
    };
  }

  // Build the raw RFC 822 message without sending. Used for drafts and Sent-folder copies.
  async composeRaw(account: ImapAccount, email: EmailComposer): Promise<Buffer> {
    const compiled = new MailComposer(this.toMailOptions(account, email));
    return compiled.compile().build();
  }

  async sendEmail(accountId: string, account: ImapAccount, email: EmailComposer): Promise<{ messageId: string; rawMessage?: Buffer }> {
    try {
      const transporter = await this.createTransporter(account);
      const mailOptions = this.toMailOptions(account, email);

      // Build raw message for IMAP Sent folder append
      let rawMessage: Buffer | undefined;
      try {
        rawMessage = await this.composeRaw(account, email);
      } catch {
        // Non-critical: sent folder copy will be skipped
      }

      const info = await transporter.sendMail(mailOptions);
      return { messageId: info.messageId, rawMessage };
    } catch (error) {
      throw new Error(`Failed to send email: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  disconnect(accountId: string): void {
    const cached = this.transporters.get(accountId);
    if (cached) {
      try { cached.transporter.close(); } catch { /* deja ferme */ }
      this.transporters.delete(accountId);
    }
  }

  disconnectAll(): void {
    for (const { transporter } of this.transporters.values()) {
      try { transporter.close(); } catch { /* deja ferme */ }
    }
    this.transporters.clear();
  }
}
