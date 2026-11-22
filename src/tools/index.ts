import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { oauthTools } from './oauth-tools.js';
import { ImapService } from '../services/imap-service.js';
import { AccountManager } from '../services/account-manager.js';
import { SmtpService } from '../services/smtp-service.js';
import { SpamService } from '../services/spam-service.js';
import { accountTools } from './account-tools.js';
import { emailTools } from './email-tools.js';
import { folderTools } from './folder-tools.js';
import { spamTools } from './spam-tools.js';
import { pdfExportTools } from './pdf-export-tools.js';

// Chaque outil declare dans `_meta` (config de registerTool) son connecteur, la famille
// de droits a laquelle il appartient, « hobbitton.at/connecteur » (null : servi mais
// ferme), et s'il agit, « hobbitton.at/agit » (ecrit, envoie, supprime, modifie). Le
// planificateur de la plateforme construit sa table d'acces depuis ce que publie
// `tools/list` ; tests/tool-declarations.test.ts echoue pour un outil publie sans declaration.
export function registerTools(
  server: McpServer,
  imapService: ImapService,
  accountManager: AccountManager,
  smtpService: SmtpService,
  spamService: SpamService
): void {
  // Register account management tools
  accountTools(server, accountManager, imapService, smtpService);
  oauthTools(server, accountManager, imapService, smtpService);

  // Register email operation tools
  emailTools(server, imapService, accountManager, smtpService);

  // Register folder operation tools
  folderTools(server, imapService, accountManager);

  // Register spam detection and management tools
  spamTools(server, imapService, spamService);

  // Export d'un email en PDF (justificatifs Qonto sans piece jointe) -- ajout hobbitton 21/08/2026
  pdfExportTools(server, imapService, accountManager);
}
