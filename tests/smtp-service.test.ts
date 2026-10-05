import { describe, it, expect, vi, beforeEach } from 'vitest';

const createTransport = vi.fn();
vi.mock('nodemailer', () => ({
  default: { createTransport: (...args: any[]) => createTransport(...args) },
}));
vi.mock('nodemailer/lib/mail-composer/index.js', () => ({
  default: class { compile() { return { build: async () => Buffer.from('raw') }; } },
}));

import { SmtpService } from '../src/services/smtp-service.js';

const account: any = {
  id: 'acc', name: 'Compte', host: 'imap.example.org', port: 993, tls: true,
  user: 'u@example.org', password: 'secret', email: 'u@example.org',
  smtp: { host: 'smtp.example.org', port: 587, secure: false },
};

describe('SmtpService (pool, 05/10/2026)', () => {
  beforeEach(() => {
    createTransport.mockReset();
    createTransport.mockImplementation(() => ({
      sendMail: vi.fn().mockResolvedValue({ messageId: '<id@example.org>' }),
      verify: vi.fn().mockResolvedValue(true),
      close: vi.fn(),
    }));
  });

  it('builds one pooled transporter per account and reuses it', async () => {
    const service = new SmtpService();
    await service.sendEmail(account.id, account, { to: 'a@b.c', subject: 's', text: 't' } as any);
    await service.sendEmail(account.id, account, { to: 'a@b.c', subject: 's', text: 't' } as any);
    expect(createTransport).toHaveBeenCalledTimes(1);
    const options = createTransport.mock.calls[0][0];
    expect(options.pool).toBe(true);
    expect(options.maxConnections).toBe(1);
    expect(options.requireTLS).toBe(true);
    // Pas de verify() a la creation : c'etait une connexion de plus par envoi.
    const transporter = createTransport.mock.results[0].value;
    expect(transporter.verify).not.toHaveBeenCalled();
  });

  it('disconnectAll closes the pools', async () => {
    const service = new SmtpService();
    await service.sendEmail(account.id, account, { to: 'a@b.c', subject: 's', text: 't' } as any);
    service.disconnectAll();
    expect(createTransport.mock.results[0].value.close).toHaveBeenCalled();
  });
});
