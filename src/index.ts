import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import dotenv from 'dotenv';
import { ImapService } from './services/imap-service.js';
import { AccountManager } from './services/account-manager.js';
import { SmtpService } from './services/smtp-service.js';
import { SpamService } from './services/spam-service.js';
import { registerTools } from './tools/index.js';

// Silence any package version output to stdout
const originalWrite = process.stdout.write.bind(process.stdout);
(process.stdout.write as any) = function(chunk: any, encoding?: any, callback?: any): boolean {
  // Only allow JSON-RPC messages through
  if (typeof chunk === 'string' && (chunk.startsWith('{') || chunk === '\n')) {
    return originalWrite(chunk, encoding, callback);
  }
  return true;
};

dotenv.config();

const server = new McpServer({
  name: 'imap-mcp-server',
  version: '1.0.0',
});

const imapService = new ImapService();
const accountManager = new AccountManager();
const smtpService = new SmtpService();
const spamService = new SpamService();

// Allow ImapService to auto-connect using stored credentials
imapService.setAccountManager(accountManager);

// Register all tools
registerTools(server, imapService, accountManager, smtpService, spamService);

// Arret propre : LOGOUT sur chaque connexion IMAP et fermeture des pools SMTP, puis
// sortie. Sans cela (jusqu'au 05/10/2026) le SIGTERM du proxy tuait le processus avec
// ses sessions ouvertes, que les serveurs gardaient jusqu'a leur propre delai.
let stopping = false;
async function shutdown(reason: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.error(`IMAP MCP Server stopping (${reason})`);
  const timer = setTimeout(() => process.exit(0), 5000);
  timer.unref?.();
  try {
    smtpService.disconnectAll();
    await imapService.disconnectAll();
  } finally {
    process.exit(0);
  }
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Le proxy ferme stdin pour arreter un backend : la fin du transport vaut un arret.
  server.server.onclose = () => { void shutdown('transport closed'); };
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => { void shutdown(signal); });
  }
  console.error('IMAP MCP Server started');
}

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});