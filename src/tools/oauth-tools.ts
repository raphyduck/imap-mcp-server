import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { AccountManager } from '../services/account-manager.js';
import { ImapService } from '../services/imap-service.js';
import { SmtpService } from '../services/smtp-service.js';
import {
  MICROSOFT_DEFAULTS,
  setOAuthAccountManager,
  startMicrosoftDeviceFlow,
  pollMicrosoftDeviceFlow,
  primeAccessToken,
} from '../services/oauth-service.js';

const text = (obj: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(obj, null, 2) }] });

export function oauthTools(
  server: McpServer,
  accountManager: AccountManager,
  imapService: ImapService,
  smtpService: SmtpService
): void {
  setOAuthAccountManager(accountManager);

  // @ts-expect-error TS2589: MCP SDK registerTool + zod v3 exceed TS's type instantiation depth limit.
  server.registerTool('imap_oauth_start', {
    description: 'Start an OAuth2 (XOAUTH2) sign-in for a Microsoft mailbox (hotmail.*, outlook.*, live.*), where IMAP password login is disabled ("Login is disabled"). Returns verificationUri and userCode: the user opens the URL, enters the code, signs in with that mailbox and accepts. Then call imap_oauth_complete with the userCode.',
    inputSchema: {
      clientId: z.string().optional().describe(`Azure app (public client) ID. Default: MS_OAUTH_CLIENT_ID or ${MICROSOFT_DEFAULTS.clientId}`),
      tenant: z.string().optional().describe('consumers (default, personal accounts), organizations, or a tenant ID for work accounts'),
    },
  }, async ({ clientId, tenant }: { clientId?: string; tenant?: string }) => {
    const r = await startMicrosoftDeviceFlow({ clientId, tenant });
    return text({
      ...r,
      next: 'Open verificationUri, enter userCode, sign in with the mailbox and accept. Then call imap_oauth_complete with this userCode.',
    });
  });

  // @ts-expect-error TS2589
  server.registerTool('imap_oauth_complete', {
    description: 'Finish a Microsoft OAuth2 sign-in started with imap_oauth_start. Waits for the user approval (up to waitSeconds), then creates the IMAP/SMTP account (outlook.office365.com / smtp-mail.outlook.com, XOAUTH2) or, with accountId, stores the new refresh token on an existing account. Tests the IMAP connection.',
    inputSchema: {
      userCode: z.string().describe('userCode returned by imap_oauth_start'),
      email: z.string().optional().describe('Mailbox address (login and From). Required when creating an account'),
      name: z.string().optional().describe('Friendly name. Required when creating an account'),
      accountId: z.string().optional().describe('Existing account to re-authorize instead of creating one'),
      waitSeconds: z.coerce.number().default(60).describe('How long to wait for the approval (max 110)'),
    },
  }, async ({ userCode, email, name, accountId, waitSeconds }: { userCode: string; email?: string; name?: string; accountId?: string; waitSeconds: number }) => {
    if (!accountId && (!email || !name)) {
      throw new Error('email et name sont requis pour creer le compte (ou accountId pour re-autoriser un compte existant).');
    }
    const r = await pollMicrosoftDeviceFlow(userCode, waitSeconds);
    if (r.status === 'pending') {
      return text({ status: 'pending', message: 'Autorisation pas encore donnee : rappeler imap_oauth_complete avec le meme userCode.' });
    }

    let account;
    if (accountId) {
      account = await accountManager.updateAccount(accountId, { oauth2: r.oauth2 });
      await imapService.disconnect(accountId);
    } else {
      account = await accountManager.addAccount({
        name: name!,
        host: MICROSOFT_DEFAULTS.imapHost,
        port: 993,
        user: email!,
        password: '',
        tls: true,
        email,
        smtp: { host: MICROSOFT_DEFAULTS.smtpHost, port: 587, secure: false },
        oauth2: r.oauth2,
      });
    }
    primeAccessToken(account.id, r.accessToken, r.expiresIn);
    const test = await imapService.testConnection(account);
    return text({ status: 'ok', accountId: account.id, name: account.name, user: account.user, test });
  });
}
