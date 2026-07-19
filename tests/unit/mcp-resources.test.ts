import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { describe, expect, it, vi } from 'vitest';
import {
  McpResourceSubscriptions,
  type McpResourceCatalog,
} from '../../src/server/mcp-resources.js';

describe('McpResourceSubscriptions', () => {
  it('emits resource-updated only when a subscribed resource fingerprint changes', async () => {
    let fingerprint = 'a';
    const sendResourceUpdated = vi.fn(async () => undefined);
    const server = { sendResourceUpdated } as unknown as Server;
    const catalog = {
      has: (uri: string) => uri === 'folderforge://test',
      fingerprint: async () => fingerprint,
    } as unknown as McpResourceCatalog;
    const subscriptions = new McpResourceSubscriptions(server, catalog, 10);

    try {
      await subscriptions.subscribe('folderforge://test');
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(sendResourceUpdated).not.toHaveBeenCalled();

      fingerprint = 'b';
      await vi.waitFor(() => expect(sendResourceUpdated).toHaveBeenCalledWith({ uri: 'folderforge://test' }));
      const count = sendResourceUpdated.mock.calls.length;
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(sendResourceUpdated).toHaveBeenCalledTimes(count);

      subscriptions.unsubscribe('folderforge://test');
      fingerprint = 'c';
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(sendResourceUpdated).toHaveBeenCalledTimes(count);
    } finally {
      subscriptions.dispose();
    }
  });

  it('rejects unknown resources before allocating a polling timer', async () => {
    const server = { sendResourceUpdated: vi.fn() } as unknown as Server;
    const catalog = {
      has: () => false,
      fingerprint: vi.fn(),
    } as unknown as McpResourceCatalog;
    const subscriptions = new McpResourceSubscriptions(server, catalog, 10);

    await expect(subscriptions.subscribe('folderforge://unknown')).rejects.toThrow(/unknown resource/i);
    subscriptions.dispose();
  });
});
