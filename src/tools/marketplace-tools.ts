import { readFileSync, writeFileSync } from 'node:fs';
import type { ToolDefinition, ToolResult } from '../core/types.js';
import type { MarketplaceModerationState, MarketplaceProvenance } from '../marketplace/marketplace-manager.js';
import { defineTool } from './registry.js';

function fail(error: unknown): ToolResult {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

const objectOutput = { type: 'object', additionalProperties: true } as const;

export function marketplaceTools(): ToolDefinition[] {
  return [
    defineTool({
      name: 'marketplace_list',
      description: 'Search the local verified marketplace index with publisher, signature, moderation, and quarantine trust state.',
      group: 'marketplace',
      mutates: false,
      risk: 'LOW',
      inputSchema: { type: 'object', properties: { query: { type: 'string', maxLength: 256 } } },
      outputSchema: objectOutput,
      handler: async (args, ctx) => ({ ok: true, data: { entries: ctx.container.marketplace.list(String(args.query ?? '')) } }),
    }),
    defineTool({
      name: 'marketplace_inspect',
      description: 'Inspect one immutable marketplace version and its publisher, signatures, provenance, SBOM digest, moderation, and quarantine evidence.',
      group: 'marketplace',
      mutates: false,
      risk: 'LOW',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' }, version: { type: 'string' } },
        required: ['id', 'version'],
      },
      outputSchema: objectOutput,
      handler: async (args, ctx) => {
        try { return { ok: true, data: ctx.container.marketplace.inspect(String(args.id ?? ''), String(args.version ?? '')) }; }
        catch (error) { return fail(error); }
      },
    }),
    defineTool({
      name: 'marketplace_scan',
      description: 'Scan a local prepared plugin directory for compatibility, secrets, lifecycle scripts, symlinks, nested archives, size limits, SBOM, and provenance.',
      group: 'marketplace',
      audience: 'admin',
      mutates: false,
      risk: 'LOW',
      inputSchema: { type: 'object', properties: { source: { type: 'string' } }, required: ['source'] },
      outputSchema: objectOutput,
      handler: async (args, ctx) => {
        try { return { ok: true, data: ctx.container.marketplace.scanDirectory(String(args.source ?? '')) }; }
        catch (error) { return fail(error); }
      },
    }),
    defineTool({
      name: 'marketplace_sync',
      description: 'Import a bounded HTTPS/local marketplace index, verify every publisher signature, and reject immutable version conflicts.',
      group: 'marketplace',
      mutates: true,
      risk: 'HIGH',
      annotations: { openWorldHint: true },
      inputSchema: {
        type: 'object',
        properties: { source: { type: 'string' }, expectedSha256: { type: 'string', pattern: '^[a-f0-9]{64}$' } },
        required: ['source'],
      },
      outputSchema: objectOutput,
      handler: async (args, ctx) => {
        try { return { ok: true, data: await ctx.container.marketplace.syncIndex(String(args.source ?? ''), typeof args.expectedSha256 === 'string' ? args.expectedSha256 : undefined) }; }
        catch (error) { return fail(error); }
      },
    }),
    defineTool({
      name: 'marketplace_quarantine',
      description: 'Fetch a signed digest-pinned package, safely extract it in quarantine, and run all trust/compatibility/security scans without installing it.',
      group: 'marketplace',
      mutates: true,
      risk: 'HIGH',
      annotations: { openWorldHint: true },
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' }, version: { type: 'string' } },
        required: ['id', 'version'],
      },
      outputSchema: objectOutput,
      handler: async (args, ctx) => {
        try { return { ok: true, data: await ctx.container.marketplace.quarantine(String(args.id ?? ''), String(args.version ?? '')) }; }
        catch (error) { return fail(error); }
      },
    }),
    defineTool({
      name: 'marketplace_install',
      description: 'Install a trusted quarantine-passed marketplace package in disabled state for separate inspection and governed enablement.',
      group: 'marketplace',
      mutates: true,
      risk: 'HIGH',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' }, version: { type: 'string' } },
        required: ['id', 'version'],
      },
      outputSchema: objectOutput,
      handler: async (args, ctx) => {
        try { return { ok: true, data: { installed: ctx.container.marketplace.install(String(args.id ?? ''), String(args.version ?? '')), enabled: false } }; }
        catch (error) { return fail(error); }
      },
    }),
    defineTool({
      name: 'marketplace_export',
      description: 'Export the verified immutable local index to a local JSON file for review or registry hosting.',
      group: 'marketplace',
      audience: 'admin',
      mutates: true,
      risk: 'MEDIUM',
      inputSchema: { type: 'object', properties: { output: { type: 'string' } }, required: ['output'] },
      outputSchema: objectOutput,
      handler: async (args, ctx) => {
        try {
          const output = String(args.output ?? '');
          const index = ctx.container.marketplace.exportIndex();
          writeFileSync(output, JSON.stringify(index, null, 2) + '\n', { mode: 0o600 });
          return { ok: true, data: { output, entries: index.entries.length } };
        } catch (error) { return fail(error); }
      },
    }),
    defineTool({
      name: 'marketplace_package',
      description: 'Create a deterministic tgz and Ed25519-signed immutable entry from a locally scanned plugin package with SBOM and provenance.',
      group: 'marketplace',
      audience: 'admin',
      mutates: true,
      risk: 'HIGH',
      inputSchema: {
        type: 'object',
        properties: {
          source: { type: 'string' }, output: { type: 'string' }, packageUrl: { type: 'string' }, publisherId: { type: 'string' }, privateKeyPath: { type: 'string' }, provenance: { type: 'object', additionalProperties: true },
        },
        required: ['source', 'output', 'publisherId', 'privateKeyPath', 'provenance'],
      },
      outputSchema: objectOutput,
      handler: async (args, ctx) => {
        try {
          return {
            ok: true,
            data: await ctx.container.marketplace.createPackage({
              sourceDir: String(args.source ?? ''),
              outputFile: String(args.output ?? ''),
              publisherId: String(args.publisherId ?? ''),
              privateKeyPem: readFileSync(String(args.privateKeyPath ?? ''), 'utf8'),
              provenance: args.provenance as MarketplaceProvenance,
              ...(typeof args.packageUrl === 'string' ? { packageUrl: args.packageUrl } : {}),
            }),
          };
        } catch (error) { return fail(error); }
      },
    }),
    defineTool({
      name: 'marketplace_publisher_add',
      description: 'Add a trusted Ed25519 publisher identity to the local marketplace trust store.',
      group: 'marketplace',
      audience: 'admin',
      mutates: true,
      risk: 'HIGH',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' }, name: { type: 'string' }, publicKeyPem: { type: 'string' } },
        required: ['id', 'name', 'publicKeyPem'],
      },
      outputSchema: objectOutput,
      handler: async (args, ctx) => {
        try { return { ok: true, data: ctx.container.marketplace.addPublisher({ id: String(args.id ?? ''), name: String(args.name ?? ''), publicKeyPem: String(args.publicKeyPem ?? '') }) }; }
        catch (error) { return fail(error); }
      },
    }),
    defineTool({
      name: 'marketplace_publisher_revoke',
      description: 'Revoke a publisher identity so its indexed packages can no longer be quarantined or installed.',
      group: 'marketplace',
      audience: 'admin',
      mutates: true,
      risk: 'HIGH',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' }, reason: { type: 'string', maxLength: 1000 } },
        required: ['id'],
      },
      outputSchema: objectOutput,
      handler: async (args, ctx) => {
        try { return { ok: true, data: ctx.container.marketplace.revokePublisher(String(args.id ?? ''), String(args.reason ?? 'Revoked by operator.')) }; }
        catch (error) { return fail(error); }
      },
    }),
    defineTool({
      name: 'marketplace_publisher_list',
      description: 'List trusted and revoked marketplace publisher identities without public-key material.',
      group: 'marketplace',
      audience: 'admin',
      mutates: false,
      risk: 'LOW',
      inputSchema: { type: 'object', properties: {} },
      outputSchema: objectOutput,
      handler: async (_args, ctx) => ({ ok: true, data: { publishers: ctx.container.marketplace.listPublishers() } }),
    }),
    defineTool({
      name: 'marketplace_moderate',
      description: 'Apply a local listed, yanked, or security-hold decision without modifying the publisher-signed immutable entry.',
      group: 'marketplace',
      audience: 'admin',
      mutates: true,
      risk: 'HIGH',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' }, version: { type: 'string' }, state: { type: 'string', enum: ['listed', 'yanked', 'security-hold'] }, reason: { type: 'string', maxLength: 2000 } },
        required: ['id', 'version', 'state'],
      },
      outputSchema: objectOutput,
      handler: async (args, ctx) => {
        try { return { ok: true, data: ctx.container.marketplace.moderate(String(args.id ?? ''), String(args.version ?? ''), String(args.state) as MarketplaceModerationState, typeof args.reason === 'string' ? args.reason : undefined) }; }
        catch (error) { return fail(error); }
      },
    }),
  ];
}
