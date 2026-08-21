import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ImapService } from '../services/imap-service.js';
import { AccountManager } from '../services/account-manager.js';
import { z } from 'zod';
import { createHash } from 'crypto';
import { createWriteStream, mkdirSync, statSync, readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { convert } from 'html-to-text';

// Export d'un email en PDF, côté serveur (ajout hobbitton, 21/08/2026).
//
// Pourquoi : les reçus « sans pièce jointe » (Stripe, Webshare, avis de
// dividende SCPI...) doivent devenir un justificatif Qonto. Les agents du
// scheduler n'ont ni shell ni navigateur, et aucun octet ne doit transiter
// par le modèle. Cet outil rend donc l'email (en-têtes + corps texte) en PDF
// directement sur le volume partagé, prêt pour qonto_upload_attachment_from_file.
//
// Rendu : pdfkit, police Helvetica embarquée (pas de Chromium). Le HTML est
// converti en texte structuré par html-to-text (liens conservés, images et
// scripts ignorés) : c'est fidèle au contenu, pas à la mise en page.

const EXPORT_ROOT = process.env.IMAP_PDF_EXPORT_ROOT || '/srv/filemcp';

// Repare un texte decode avec le mauvais charset (UTF-8 lu comme latin1 :
// « Ã© » au lieu de « é »). On ne remplace que si le re-decodage est propre.
function fixMojibake(s: string): string {
  if (!/Ã[\u0080-\u00BF]|Â[\u00A0-\u00BF]/.test(s)) return s;
  const re = Buffer.from(s, 'latin1').toString('utf8');
  if (re.includes('\uFFFD')) return s;
  return re;
}

function stripControl(s: string): string {
  // pdfkit écrit tel quel ; on retire les caractères de contrôle (sauf \n, \t).
  return s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

export function pdfExportTools(
  server: McpServer,
  imapService: ImapService,
  accountManager: AccountManager
): void {
  server.registerTool('imap_export_email_pdf', {
    description:
      'Render an email (headers + body text) to a PDF file saved server-side under the shared volume (default /srv/filemcp). ' +
      'Meant for receipts/invoices that have NO attachment (Stripe, SaaS receipts, dividend notices): the resulting PDF can be ' +
      'attached to a Qonto transaction with qonto_upload_attachment_from_file. No bytes pass through the model. ' +
      'Returns path, size_bytes and sha256. Does not mark the email as read.',
    inputSchema: {
      accountId: z.string().optional().describe('Account ID (from imap_list_accounts). Optional if accountName is given or only one account is configured.'),
      accountName: z.string().optional().describe('Account name instead of accountId.'),
      folder: z.string().default('INBOX').describe('Folder name'),
      uid: z.coerce.number().describe('Email UID'),
      savePath: z.string().describe('Absolute target path under the shared volume, e.g. /srv/filemcp/qonto-inbox/2026-08-21_stripe_1234.pdf'),
      title: z.string().optional().describe('Optional title printed at the top of the PDF (e.g. "Justificatif — reçu Stripe #1234"). Defaults to the email subject.'),
      note: z.string().optional().describe('Optional note printed at the end (e.g. the matched Qonto transaction id). The messageId is always printed.'),
      maxChars: z.coerce.number().default(40000).describe('Maximum number of body characters rendered (protects against huge newsletters).'),
    }
  }, async ({ accountId: rawAccountId, accountName, folder, uid, savePath, title, note, maxChars }) => {
    const accountId = accountManager.resolveAccountId(rawAccountId, accountName);

    const target = resolve(savePath);
    const root = resolve(EXPORT_ROOT);
    if (!target.startsWith(root + '/')) {
      throw new Error(`savePath must be under ${root} (got ${target})`);
    }
    if (!target.toLowerCase().endsWith('.pdf')) {
      throw new Error('savePath must end with .pdf');
    }

    const email = await imapService.getEmailContent(accountId, folder, uid);

    // Le HTML est prefere : la partie text/plain des emails marketing est
    // souvent une version degradee (references d'images, liens de tracking).
    let body = '';
    if (email.htmlContent) {
      body = convert(email.htmlContent, {
        wordwrap: false,
        selectors: [
          { selector: 'img', format: 'skip' },
          { selector: 'script', format: 'skip' },
          { selector: 'style', format: 'skip' },
          { selector: 'a', options: { ignoreHref: true } },
        ],
      }).trim();
    }
    if (!body) body = (email.textContent || '').trim();
    body = fixMojibake(body).replace(/\n{3,}/g, '\n\n');
    if (!body) body = '(corps de message vide)';
    let truncated = false;
    if (body.length > maxChars) {
      body = body.slice(0, maxChars) + '\n\n[... contenu tronqué ...]';
      truncated = true;
    }
    body = stripControl(body);

    const PDFDocument = (await import('pdfkit')).default;
    mkdirSync(dirname(target), { recursive: true });

    await new Promise<void>((resolveDone, reject) => {
      const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: title || email.subject || 'Email', Author: 'imap-mcp export' } });
      const out = createWriteStream(target);
      out.on('finish', () => resolveDone());
      out.on('error', reject);
      doc.on('error', reject);
      doc.pipe(out);

      doc.font('Helvetica-Bold').fontSize(14).text(stripControl(title || email.subject || '(sans objet)'));
      doc.moveDown(0.5);
      doc.font('Helvetica').fontSize(9).fillColor('#444444');
      const dateStr = email.date instanceof Date ? email.date.toISOString() : String(email.date);
      const lines = [
        `De : ${email.from}`,
        `À : ${(email.to || []).join(', ')}`,
        email.cc && email.cc.length ? `Cc : ${email.cc.join(', ')}` : null,
        `Date : ${dateStr}`,
        `Objet : ${email.subject || ''}`,
        `Message-Id : ${email.messageId || ''}`,
        email.attachments && email.attachments.length
          ? `Pièces jointes (non incluses) : ${email.attachments.map(a => a.filename).join(', ')}`
          : null,
      ].filter(Boolean) as string[];
      for (const l of lines) doc.text(stripControl(l));
      doc.moveDown(0.5);
      doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#999999').stroke();
      doc.moveDown(0.5);

      doc.fillColor('#000000').fontSize(10).text(body, { lineGap: 2 });

      doc.moveDown(1);
      doc.fontSize(8).fillColor('#666666');
      doc.text(`Justificatif généré depuis l'email par imap-mcp le ${new Date().toISOString()} (compte ${accountId}, dossier ${folder}, uid ${uid}).`);
      if (note) doc.text(stripControl(note));
      doc.end();
    });

    const size = statSync(target).size;
    const sha256 = createHash('sha256').update(readFileSync(target)).digest('hex');

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          saved: true,
          path: target,
          size_bytes: size,
          sha256,
          subject: email.subject,
          from: email.from,
          date: email.date,
          messageId: email.messageId,
          body_chars: body.length,
          truncated,
        }, null, 2)
      }]
    };
  });
}
