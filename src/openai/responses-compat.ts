/** OpenAI Responses-compatible protocol primitives.
 *
 * This module is deliberately transport-agnostic: HTTP/SSE adapters can share
 * validation, input normalization, identifiers, and terminal-state handling
 * without bypassing FolderForge's governed ToolRegistry pipeline.
 */

import { randomBytes } from 'node:crypto';

export const RESPONSES_API_VERSION = '2026-09-14';

export interface OpenAiModel {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
  capabilities: { responses: true; streaming: true; tools: true };
}

export const FOLDERFORGE_MODELS: readonly OpenAiModel[] = [
  {
    id: 'folderforge-agent',
    object: 'model',
    created: 0,
    owned_by: 'folderforge',
    capabilities: { responses: true, streaming: true, tools: true },
  },
] as const;

export type ResponseInputText = { type: 'input_text'; text: string };
export type ResponseInputImage = { type: 'input_image'; image_url?: string; detail?: string };
export type ResponseInputContent = ResponseInputText | ResponseInputImage;
export type ResponseRole = 'user' | 'assistant' | 'system' | 'developer';

export interface ResponseMessageItem {
  type: 'message';
  role: ResponseRole;
  content: string | ResponseInputContent[];
}

export interface ResponseFunctionCallItem {
  type: 'function_call';
  call_id: string;
  name: string;
  arguments: string;
}

export interface ResponseFunctionCallOutputItem {
  type: 'function_call_output';
  call_id: string;
  output: string;
}

export type ResponseInputItem = ResponseMessageItem | ResponseFunctionCallItem | ResponseFunctionCallOutputItem;

export interface ResponsesRequest {
  model?: string;
  input: string | ResponseInputItem[];
  instructions?: string;
  tools?: readonly unknown[];
  stream?: boolean;
  background?: boolean;
  store?: boolean;
  previous_response_id?: string;
  metadata?: Record<string, string>;
  temperature?: number;
  max_output_tokens?: number;
}

export interface NormalizedPrompt {
  instructions: string;
  messages: Array<{ role: ResponseRole; content: string }>;
  toolCalls: ResponseFunctionCallItem[];
  toolOutputs: ResponseFunctionCallOutputItem[];
}

export type ResponseStatus = 'queued' | 'in_progress' | 'completed' | 'failed' | 'cancelled';

export interface ResponseUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

export interface ResponseRecord {
  id: string;
  object: 'response';
  created_at: number;
  status: ResponseStatus;
  model: string;
  output: unknown[];
  output_text: string;
  error: { code: string; message: string } | null;
  usage: ResponseUsage | null;
  metadata: Record<string, string>;
}

export type ResponsesEvent =
  | { type: 'response.created'; response: ResponseRecord }
  | { type: 'response.in_progress'; response: ResponseRecord }
  | { type: 'response.output_text.delta'; item_id: string; delta: string; output_index: number }
  | { type: 'response.output_text.done'; item_id: string; text: string; output_index: number }
  | { type: 'response.completed'; response: ResponseRecord }
  | { type: 'response.failed'; response: ResponseRecord }
  | { type: 'response.cancelled'; response: ResponseRecord };

export function newResponseId(): string {
  return `resp_${randomBytes(16).toString('hex')}`;
}

export function normalizeResponseInput(request: ResponsesRequest): NormalizedPrompt {
  const messages: Array<{ role: ResponseRole; content: string }> = [];
  const toolCalls: ResponseFunctionCallItem[] = [];
  const toolOutputs: ResponseFunctionCallOutputItem[] = [];
  const instructions = request.instructions?.trim() ?? '';
  if (typeof request.input === 'string') {
    messages.push({ role: 'user', content: request.input });
  } else {
    for (const item of request.input) {
      if (item.type === 'message') {
        const content = typeof item.content === 'string'
          ? item.content
          : item.content.filter((part): part is ResponseInputText => part.type === 'input_text').map((part) => part.text).join('');
        if (content) messages.push({ role: item.role, content });
      } else if (item.type === 'function_call') {
        toolCalls.push(item);
      } else {
        toolOutputs.push(item);
      }
    }
  }
  if (messages.length === 0 && toolOutputs.length === 0 && toolCalls.length === 0) {
    throw new Error('input must contain text, a function call, or function call output');
  }
  return { instructions, messages, toolCalls, toolOutputs };
}

export function modelById(id = FOLDERFORGE_MODELS[0]!.id): OpenAiModel {
  const model = FOLDERFORGE_MODELS.find((candidate) => candidate.id === id);
  if (!model) throw new Error(`model_not_found: ${id}`);
  return model;
}

export function responseSnapshot(response: ResponseRecord): ResponseRecord {
  return JSON.parse(JSON.stringify(response)) as ResponseRecord;
}

export function sseEvent(event: ResponsesEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
