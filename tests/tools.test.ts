import { describe, it, expect, vi, beforeEach } from 'vitest';

// Test that tools are properly exported and structured
describe('Tools Module', () => {
  describe('Tool Registration', () => {
    it('should export registerTools function', async () => {
      const toolsModule = await import('../src/tools/index.js');
      expect(toolsModule.registerTools).toBeDefined();
      expect(typeof toolsModule.registerTools).toBe('function');
    });

    it('should export accountTools function', async () => {
      const accountToolsModule = await import('../src/tools/account-tools.js');
      expect(accountToolsModule.accountTools).toBeDefined();
      expect(typeof accountToolsModule.accountTools).toBe('function');
    });

    it('should export emailTools function', async () => {
      const emailToolsModule = await import('../src/tools/email-tools.js');
      expect(emailToolsModule.emailTools).toBeDefined();
      expect(typeof emailToolsModule.emailTools).toBe('function');
    });

    it('should export folderTools function', async () => {
      const folderToolsModule = await import('../src/tools/folder-tools.js');
      expect(folderToolsModule.folderTools).toBeDefined();
      expect(typeof folderToolsModule.folderTools).toBe('function');
    });

    it('should export spamTools function', async () => {
      const spamToolsModule = await import('../src/tools/spam-tools.js');
      expect(spamToolsModule.spamTools).toBeDefined();
      expect(typeof spamToolsModule.spamTools).toBe('function');
    });
  });
});

describe('Types', () => {
  it('should export all required types', async () => {
    // This test ensures the types module compiles and exports correctly
    const typesModule = await import('../src/types/index.js');

    // Types are compile-time only, but we can check the module loads
    expect(typesModule).toBeDefined();
  });
});

describe('Services Export', () => {
  it('should export ImapService', async () => {
    const imapModule = await import('../src/services/imap-service.js');
    expect(imapModule.ImapService).toBeDefined();
  });

  it('should export AccountManager', async () => {
    const accountModule = await import('../src/services/account-manager.js');
    expect(accountModule.AccountManager).toBeDefined();
  });

  it('should export SmtpService', async () => {
    const smtpModule = await import('../src/services/smtp-service.js');
    expect(smtpModule.SmtpService).toBeDefined();
  });

  it('should export SpamService', async () => {
    const spamModule = await import('../src/services/spam-service.js');
    expect(spamModule.SpamService).toBeDefined();
  });
});
