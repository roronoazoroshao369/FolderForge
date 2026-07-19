import type { GetPromptResult, Prompt } from '@modelcontextprotocol/sdk/types.js';

export interface FolderForgePromptDefinition extends Prompt {
  render: (args: Record<string, string>) => GetPromptResult;
}

function required(args: Record<string, string>, name: string): string {
  const value = args[name]?.trim();
  if (!value) throw new Error(`Prompt argument is required: ${name}`);
  return value;
}

function scopeLine(args: Record<string, string>): string {
  const scope = args.scope?.trim();
  return scope ? `\nScope constraint: ${scope}` : '';
}

export class McpPromptCatalog {
  private readonly prompts = new Map<string, FolderForgePromptDefinition>();

  constructor() {
    this.register({
      name: 'folderforge/deep-implementation-cycle',
      title: 'Deep implementation cycle',
      description:
        'Run Discover → Analyze → Plan → Implement → Review → Test → Fix → Release Check for one bounded engineering objective.',
      arguments: [
        { name: 'objective', description: 'Concrete engineering objective.', required: true },
        { name: 'scope', description: 'Optional files, subsystem, or constraints.' },
      ],
      render: (args) => ({
        description: 'A governed, evidence-driven implementation workflow.',
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text:
                `Implement this objective: ${required(args, 'objective')}.${scopeLine(args)}\n\n` +
                'Use this exact sequence: Discover → Analyze → Plan → Implement → Review → Test → Fix → Release Check. ' +
                'At each phase, record concrete evidence, preserve unrelated work, keep changes bounded and reversible, ' +
                'run all operations through FolderForge governance, and do not claim success until the release gate passes. ' +
                'Use folderforge://workspace/status, folderforge://git/status, folderforge://workflows, and folderforge://tasks as live context resources.',
            },
          },
        ],
      }),
    });

    this.register({
      name: 'folderforge/security-review',
      title: 'Security review',
      description: 'Review a change for trust-boundary, policy, secret, sandbox, and supply-chain failures.',
      arguments: [
        { name: 'objective', description: 'Change or subsystem to review.', required: true },
        { name: 'scope', description: 'Optional threat model or file boundary.' },
      ],
      render: (args) => ({
        description: 'FolderForge security council review prompt.',
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text:
                `Security-review this objective: ${required(args, 'objective')}.${scopeLine(args)}\n\n` +
                'Examine identity propagation, authorization before execution, approval binding, secret handling, path canonicalization, ' +
                'command/network boundaries, child-process and container isolation, replay/idempotency, audit evidence, dependency provenance, ' +
                'failure cleanup, and cross-platform behavior. Produce findings with severity, exploit path, evidence, minimal fix, and regression test.',
            },
          },
        ],
      }),
    });

    this.register({
      name: 'folderforge/release-check',
      title: 'Release check',
      description: 'Verify an exact release candidate without performing public release actions.',
      arguments: [
        { name: 'version', description: 'Candidate semantic version.', required: true },
        { name: 'scope', description: 'Optional release-specific constraints.' },
      ],
      render: (args) => ({
        description: 'Exact release-candidate verification prompt.',
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text:
                `Verify FolderForge release candidate ${required(args, 'version')}.${scopeLine(args)}\n\n` +
                'Check package/lock/changelog consistency, clean and exact Git state, schema compatibility, typecheck, tests, coverage, fuzz, stress, ' +
                'MCP conformance, documentation, dependency audits, packed-tarball install, stdio and authenticated HTTP smoke, generated artifacts, ' +
                'secret leakage, process/container cleanup, and cross-platform CI readiness. Do not push, tag, publish, create a hosted release, ' +
                'or mutate external infrastructure without explicit authorization.',
            },
          },
        ],
      }),
    });
  }

  list(): Prompt[] {
    return [...this.prompts.values()].map(({ render: _render, ...prompt }) => prompt);
  }

  get(name: string, args: Record<string, string> = {}): GetPromptResult {
    const prompt = this.prompts.get(name);
    if (!prompt) throw new Error(`Unknown prompt: ${name}`);
    return prompt.render(args);
  }

  private register(prompt: FolderForgePromptDefinition): void {
    if (this.prompts.has(prompt.name)) throw new Error(`Duplicate prompt: ${prompt.name}`);
    this.prompts.set(prompt.name, prompt);
  }
}
