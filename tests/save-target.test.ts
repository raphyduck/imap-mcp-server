import { describe, it, expect, beforeAll } from 'vitest';
import { resolve, join, sep } from 'path';

// The attachment filename comes from the sender and savePath from the caller:
// neither may write outside the downloads directory or the shared volume.
process.env.IMAP_DOWNLOAD_DIR = '/tmp/imap-test-downloads';
process.env.IMAP_SAVE_ROOT = '/tmp/imap-test-root';

let safeAttachmentName: typeof import('../src/tools/email-tools.js').safeAttachmentName;
let resolveSaveTarget: typeof import('../src/tools/email-tools.js').resolveSaveTarget;

beforeAll(async () => {
  const mod = await import('../src/tools/email-tools.js');
  safeAttachmentName = mod.safeAttachmentName;
  resolveSaveTarget = mod.resolveSaveTarget;
});

describe('safeAttachmentName', () => {
  it('keeps only the last path segment', () => {
    expect(safeAttachmentName('../../../srv/filemcp/x.pdf')).toBe('x.pdf');
    expect(safeAttachmentName('/etc/passwd')).toBe('passwd');
  });
  it('falls back for empty or dot names and strips control characters', () => {
    expect(safeAttachmentName('')).toBe('attachment');
    expect(safeAttachmentName('..')).toBe('attachment');
    expect(safeAttachmentName('a\u0000b.txt')).toBe('ab.txt');
  });
});

describe('resolveSaveTarget', () => {
  it('saves under the downloads directory by default, with a sanitised name', () => {
    expect(resolveSaveTarget(undefined, '../../x.pdf')).toBe(join(resolve('/tmp/imap-test-downloads'), 'x.pdf'));
  });
  it('accepts a savePath under the shared root or the downloads directory', () => {
    expect(resolveSaveTarget('/tmp/imap-test-root/qonto/a.pdf', 'a.pdf')).toBe(resolve('/tmp/imap-test-root/qonto/a.pdf'));
    expect(resolveSaveTarget('/tmp/imap-test-downloads/b.pdf', 'b.pdf')).toBe(resolve('/tmp/imap-test-downloads/b.pdf'));
  });
  it('rejects a savePath that climbs out, even through ..', () => {
    expect(() => resolveSaveTarget('/etc/cron.d/evil', 'x')).toThrow(/must be under/);
    expect(() => resolveSaveTarget('/tmp/imap-test-root/../other/x.pdf', 'x')).toThrow(/must be under/);
    expect(() => resolveSaveTarget(`/tmp/imap-test-root-sibling${sep}x.pdf`, 'x')).toThrow(/must be under/);
  });
});
