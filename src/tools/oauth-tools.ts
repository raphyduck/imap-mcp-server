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
  startMicrosoftAuthCodeFlow,
  completeMicrosoftAuthCodeFlow,
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
    description: 'Start an OAuth2 (XOAUTH2) sign-in for a Microsoft mailbox (hotmail.*, outlook.*, live.*), where IMAP password login is disabled ("Login is disabled"). Default flow "authcode": returns authorizeUrl; open it, sign in with the mailbox, accept; the browser then lands on an error page at http://localhost/?code=...&state=... : pass that full URL as redirectUrl to imap_oauth_complete. Flow "device" returns verificationUri + userCode instead (refused at consent for personal accounts with the default client ID).',
    inputSchema: {
      flow: z.enum(['authcode', 'device']).default('authcode').describe('authcode (default) or device'),
      loginHint: z.string().optional().describe('Mailbox address to prefill on the sign-in page (authcode flow)'),
      clientId: z.string().optional().describe(`Azure app (public client) ID. Default: MS_OAUTH_CLIENT_ID or ${MICROSOFT_DEFAULTS.clientId}`),
      tenant: z.string().optional().describe('consumers (default, personal accounts), organizations, or a tenant ID for work accounts'),
    },
  }, async ({ flow, loginHint, clientId, tenant }: { flow: 'authcode' | 'device'; loginHint?: string; clientId?: string; tenant?: string }) => {
    if (flow === 'device') {
      const r = await startMicrosoftDeviceFlow({ clientId, tenant });
      return text({ ...r, next: 'Open verificationUri, enter userCode, sign in and accept. Then call imap_oauth_complete with this userCode.' });
    }
    const r = await startMicrosoftAuthCodeFlow({ clientId, tenant, loginHint });
    return text({
      ...r,
      next: 'Open authorizeUrl, sign in with the mailbox and accept. Copy the final URL (http://localhost/?code=...&state=..., the page itself fails to load) and call imap_oauth_complete with redirectUrl within a few minutes.',
    });
  });

  // @ts-expect-error TS2589
  server.registerTool('imap_oauth_complete', {
    description: 'Finish a Microsoft OAuth2 sign-in started with imap_oauth_start: with redirectUrl (authcode flow) exchanges the code; with userCode (device flow) waits for the approval (up to waitSeconds). Then creates the IMAP/SMTP account (outlook.office365.com / smtp-mail.outlook.com, XOAUTH2) or, with accountId, stores the new refresh token on an existing account. Tests the IMAP connection.',
    inputSchema: {
      redirectUrl: z.string().optional().describe('authcode flow: full http://localhost/?code=...&state=... URL reached after accepting'),
      userCode: z.string().optional().describe('device flow: userCode returned by imap_oauth_start'),
      email: z.string().optional().describe('Mailbox address (login and From). Required when creating an account'),
      name: z.string().optional().describe('Friendly name. Required when creating an account'),
      accountId: z.string().optional().describe('Existing account to re-authorize instead of creating one'),
      waitSeconds: z.coerce.number().default(60).describe('How long to wait for the approval (max 110)'),
    },
  }, async ({ redirectUrl, userCode, email, name, accountId, waitSeconds }: { redirectUrl?: string; userCode?: string; email?: string; name?: string; accountId?: string; waitSeconds: number }) => {
    if (!redirectUrl && !userCode) throw new Error('redirectUrl (flux authcode) ou userCode (flux device) requis.');
    if (!accountId && (!email || !name)) {
      throw new Error('email et name sont requis pour creer le compte (ou accountId pour re-autoriser un compte existant).');
    }
    const r = redirectUrl
      ? await completeMicrosoftAuthCodeFlow(redirectUrl)
      : await pollMicrosoftDeviceFlow(userCode!, waitSeconds);
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
