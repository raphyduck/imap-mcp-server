import { describe, it, expect, beforeAll } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { registerTools } from '../src/tools/index.js';

const CONNECTOR_KEY = 'hobbitton.at/connecteur';
const ACTS_KEY = 'hobbitton.at/agit';

// Every tool the server publishes declares its connector in `_meta`: read here
// from a real `tools/list` answer, so a tool added later without it fails.
describe('Tool connector declarations', () => {
  let tools: Tool[];

  beforeAll(async () => {
    const server = new McpServer({ name: 'imap-mcp-server', version: 'test' });
    // Registration only stores the services; no handler runs here.
    registerTools(server, {} as any, {} as any, {} as any, {} as any);
    const client = new Client({ name: 'tool-declarations-test', version: '0' });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    tools = (await client.listTools()).tools;
    await client.close();
  });

  it('should publish tools', () => {
    expect(tools.length).toBeGreaterThan(0);
  });

  it('should declare a connector (a name or null) on every published tool', () => {
    const undeclared = tools
      .filter((tool) => {
        const meta = tool._meta;
        if (!meta || !Object.hasOwn(meta, CONNECTOR_KEY)) return true;
        const connector = meta[CONNECTOR_KEY];
        return connector !== null && (typeof connector !== 'string' || connector === '');
      })
      .map((tool) => tool.name);

    expect(undeclared).toEqual([]);
  });

  it('should say whether every published tool acts, a closed tool always', () => {
    const wrong = tools
      .filter((tool) => {
        const acts = tool._meta?.[ACTS_KEY];
        return typeof acts !== 'boolean' || (tool._meta?.[CONNECTOR_KEY] === null && !acts);
      })
      .map((tool) => tool.name);

    expect(wrong).toEqual([]);
  });
});
