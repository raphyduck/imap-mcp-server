// OAuth2 (XOAUTH2) pour les boites Microsoft personnelles (hotmail.fr, outlook.com, live.com).
// Microsoft a coupe le login IMAP/SMTP par mot de passe sur ces comptes (« Login is disabled ») :
// on obtient un refresh token par le flux « device code », puis un access token frais a chaque connexion.
import { readFileSync, mkdirSync, promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import type { ImapAccount, OAuth2Config } from '../types/index.js';
import type { AccountManager } from './account-manager.js';

export const MICROSOFT_DEFAULTS = {
  tenant: 'consumers',
  // ID public de l'application Thunderbird (client public, flux device code autorise).
  // Surchargeable par MS_OAUTH_CLIENT_ID ou par le parametre clientId de imap_oauth_start.
  clientId: process.env.MS_OAUTH_CLIENT_ID || '9e5f94bc-e8a4-4e73-b8be-63364c29d753',
  scope: 'offline_access https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send',
  imapHost: 'outlook.office365.com',
  smtpHost: 'smtp-mail.outlook.com',
};

// Le serveur tourne parfois en plusieurs processus (une session MCP = un processus) :
// les flux en attente vivent sur disque, pas en memoire.
const PENDING_PATH = path.join(os.homedir(), '.imap-mcp', 'oauth-pending.json');
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

interface PendingFlow {
  kind?: 'device' | 'authcode';
  userCode: string;
  deviceCode: string;
  state?: string;
  codeVerifier?: string;
  redirectUri?: string;
  clientId: string;
  tenant: string;
  scope: string;
  expiresAt: number;
  interval: number;
}

const tokenCache = new Map<string, { accessToken: string; expiresAt: number }>();
let accountManagerRef: AccountManager | undefined;

export function setOAuthAccountManager(am: AccountManager): void {
  accountManagerRef = am;
}

const authority = (tenant: string) => `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0`;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function postForm(url: string, params: Record<string, string>): Promise<{ ok: boolean; status: number; json: any }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  try {
    return { ok: res.ok, status: res.status, json: JSON.parse(text) };
  } catch {
    throw new Error(`Reponse OAuth illisible (HTTP ${res.status}) : ${text.slice(0, 200)}`);
  }
}

const firstLine = (s?: string) => (s || '').split(/\r?\n/)[0];

function loadPending(): PendingFlow[] {
  try {
    return JSON.parse(readFileSync(PENDING_PATH, 'utf-8')) as PendingFlow[];
  } catch {
    return [];
  }
}

async function savePending(list: PendingFlow[]): Promise<void> {
  mkdirSync(path.dirname(PENDING_PATH), { recursive: true });
  await fs.writeFile(PENDING_PATH, JSON.stringify(list, null, 2), { mode: 0o600 });
}

async function removePending(userCode: string): Promise<void> {
  await savePending(loadPending().filter(f => f.userCode !== userCode && f.expiresAt > Date.now()));
}

export async function startMicrosoftDeviceFlow(opts: { clientId?: string; tenant?: string; scope?: string } = {}) {
  const clientId = opts.clientId || MICROSOFT_DEFAULTS.clientId;
  const tenant = opts.tenant || MICROSOFT_DEFAULTS.tenant;
  const scope = opts.scope || MICROSOFT_DEFAULTS.scope;
  const r = await postForm(`${authority(tenant)}/devicecode`, { client_id: clientId, scope });
  if (!r.ok) {
    throw new Error(`Microsoft refuse le flux device code : ${r.json.error} ${firstLine(r.json.error_description)}`);
  }
  const flow: PendingFlow = {
    userCode: r.json.user_code,
    deviceCode: r.json.device_code,
    clientId,
    tenant,
    scope,
    expiresAt: Date.now() + (r.json.expires_in || 900) * 1000,
    interval: r.json.interval || 5,
  };
  const list = loadPending().filter(f => f.expiresAt > Date.now());
  list.push(flow);
  await savePending(list);
  return {
    userCode: flow.userCode,
    verificationUri: r.json.verification_uri as string,
    expiresInSeconds: r.json.expires_in as number,
  };
}

export type DevicePollResult =
  | { status: 'pending' }
  | { status: 'ok'; oauth2: OAuth2Config; accessToken: string; expiresIn: number };

export async function pollMicrosoftDeviceFlow(userCode: string, waitSeconds = 60): Promise<DevicePollResult> {
  const flow = loadPending().find(f => f.userCode === userCode);
  if (!flow) throw new Error(`Code ${userCode} inconnu ou expire : relancer imap_oauth_start.`);
  const deadline = Date.now() + Math.max(0, Math.min(waitSeconds, 110)) * 1000;
  let interval = flow.interval;
  for (;;) {
    if (Date.now() > flow.expiresAt) {
      await removePending(userCode);
      throw new Error('Code expire : relancer imap_oauth_start.');
    }
    const r = await postForm(`${authority(flow.tenant)}/token`, {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: flow.clientId,
      device_code: flow.deviceCode,
    });
    if (r.ok) {
      await removePending(userCode);
      if (!r.json.refresh_token) throw new Error('Microsoft n\'a rendu aucun refresh_token (scope offline_access absent ?).');
      return {
        status: 'ok',
        oauth2: {
          provider: 'microsoft',
          clientId: flow.clientId,
          tenant: flow.tenant,
          scope: flow.scope,
          refreshToken: r.json.refresh_token,
        },
        accessToken: r.json.access_token,
        expiresIn: r.json.expires_in || 3600,
      };
    }
    const err = r.json.error;
    if (err === 'authorization_pending' || err === 'slow_down') {
      if (err === 'slow_down') interval += 5;
      if (Date.now() + interval * 1000 > deadline) return { status: 'pending' };
      await sleep(interval * 1000);
      continue;
    }
    await removePending(userCode);
    throw new Error(`Autorisation Microsoft echouee : ${err} ${firstLine(r.json.error_description)}`);
  }
}

// Flux « code d'autorisation + PKCE » : seul flux accepte au consentement pour l'ID Thunderbird
// sur les comptes personnels (le device code y est refuse, « first party application »).
// L'utilisateur ouvre authorizeUrl, se connecte, accepte ; le navigateur part vers
// http://localhost/?code=...&state=... (page en erreur, normal) : on recupere cette URL.
export async function startMicrosoftAuthCodeFlow(opts: { clientId?: string; tenant?: string; scope?: string; loginHint?: string } = {}) {
  const clientId = opts.clientId || MICROSOFT_DEFAULTS.clientId;
  const tenant = opts.tenant || MICROSOFT_DEFAULTS.tenant;
  const scope = opts.scope || MICROSOFT_DEFAULTS.scope;
  const redirectUri = 'http://localhost';
  const codeVerifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  const state = crypto.randomBytes(12).toString('base64url');
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    response_mode: 'query',
    scope,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  });
  if (opts.loginHint) params.set('login_hint', opts.loginHint);
  const flow: PendingFlow = {
    kind: 'authcode',
    userCode: state,
    deviceCode: '',
    state,
    codeVerifier,
    redirectUri,
    clientId,
    tenant,
    scope,
    expiresAt: Date.now() + 30 * 60 * 1000,
    interval: 0,
  };
  const list = loadPending().filter(f => f.expiresAt > Date.now());
  list.push(flow);
  await savePending(list);
  return { authorizeUrl: `${authority(tenant)}/authorize?${params.toString()}`, state, expiresInSeconds: 1800 };
}

export async function completeMicrosoftAuthCodeFlow(redirectUrl: string): Promise<DevicePollResult> {
  const cleaned = redirectUrl.trim().replace(/&amp;/g, '&');
  let url: URL;
  try {
    url = new URL(cleaned);
  } catch {
    throw new Error('redirectUrl illisible : coller l\'URL complete http://localhost/?code=...&state=...');
  }
  const err = url.searchParams.get('error');
  if (err) throw new Error(`Microsoft a refuse : ${err} ${firstLine(url.searchParams.get('error_description') || '')}`);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) throw new Error('code ou state absent de redirectUrl.');
  const flow = loadPending().find(f => f.kind === 'authcode' && f.state === state);
  if (!flow) throw new Error('Flux inconnu ou expire (state) : relancer imap_oauth_start.');
  const r = await postForm(`${authority(flow.tenant)}/token`, {
    grant_type: 'authorization_code',
    client_id: flow.clientId,
    code,
    redirect_uri: flow.redirectUri!,
    code_verifier: flow.codeVerifier!,
    scope: flow.scope,
  });
  await removePending(flow.userCode);
  if (!r.ok || !r.json.refresh_token) {
    throw new Error(`Echange du code refuse : ${r.json.error} ${firstLine(r.json.error_description)} (code a usage unique, valable quelques minutes : relancer imap_oauth_start).`);
  }
  return {
    status: 'ok',
    oauth2: { provider: 'microsoft', clientId: flow.clientId, tenant: flow.tenant, scope: flow.scope, refreshToken: r.json.refresh_token },
    accessToken: r.json.access_token,
    expiresIn: r.json.expires_in || 3600,
  };
}

export function primeAccessToken(accountId: string, accessToken: string, expiresInSeconds: number): void {
  tokenCache.set(accountId, { accessToken, expiresAt: Date.now() + expiresInSeconds * 1000 });
}

export function forgetAccessToken(accountId: string): void {
  tokenCache.delete(accountId);
}

export async function getAccessToken(account: ImapAccount): Promise<string> {
  if (!account.oauth2) throw new Error(`Le compte ${account.name} n'est pas en OAuth2.`);
  const cached = tokenCache.get(account.id);
  if (cached && cached.expiresAt - REFRESH_MARGIN_MS > Date.now()) return cached.accessToken;

  // Relire le refresh token courant : un autre processus a pu le faire tourner.
  const o = accountManagerRef?.getAccount(account.id)?.oauth2 || account.oauth2;
  const r = await postForm(`${authority(o.tenant)}/token`, {
    grant_type: 'refresh_token',
    client_id: o.clientId,
    refresh_token: o.refreshToken,
    scope: o.scope,
  });
  if (!r.ok) {
    throw new Error(
      `Jeton OAuth de ${account.name} non renouvele : ${r.json.error} ${firstLine(r.json.error_description)}. ` +
      `Si invalid_grant : imap_oauth_start puis imap_oauth_complete avec accountId=${account.id}.`
    );
  }
  primeAccessToken(account.id, r.json.access_token, r.json.expires_in || 3600);
  if (r.json.refresh_token && r.json.refresh_token !== o.refreshToken && accountManagerRef) {
    try {
      await accountManagerRef.updateAccount(account.id, { oauth2: { ...o, refreshToken: r.json.refresh_token } });
    } catch (e) {
      console.error(`[OAuth] refresh token de ${account.name} non sauvegarde :`, e instanceof Error ? e.message : e);
    }
  }
  return r.json.access_token;
}

// Bloc auth pour ImapFlow : XOAUTH2 si le compte est en OAuth2, sinon login/mot de passe.
export async function buildImapAuth(account: ImapAccount): Promise<any> {
  if (account.oauth2) {
    return { user: account.user, accessToken: await getAccessToken(account) };
  }
  return { user: account.user, pass: account.password, loginMethod: account.loginMethod };
}
