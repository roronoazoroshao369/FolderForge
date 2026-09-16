import { describe, expect, it } from 'vitest';
import {
  FOLDERFORGE_MODELS,
  modelById,
  newResponseId,
  normalizeResponseInput,
  sseEvent,
} from '../../src/openai/responses-compat.js';

describe('Responses compatibility primitives', () => {
  it('publishes a stable FolderForge model catalog', () => {
    expect(FOLDERFORGE_MODELS).toHaveLength(1);
    expect(modelById('folderforge-agent').capabilities.responses).toBe(true);
    expect(() => modelById('missing')).toThrow('model_not_found');
  });

  it('normalizes text, multimodal text, and function items without losing order', () => {
    const prompt = normalizeResponseInput({
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }, { type: 'input_image', image_url: 'https://example.test/a.png' }] },
        { type: 'function_call', call_id: 'call_1', name: 'shell_exec', arguments: '{}'},
        { type: 'function_call_output', call_id: 'call_1', output: 'ok' },
      ],
      instructions: '  be concise  ',
    });
    expect(prompt.instructions).toBe('be concise');
    expect(prompt.messages).toEqual([{ role: 'user', content: 'hello' }]);
    expect(prompt.toolCalls[0]?.call_id).toBe('call_1');
    expect(prompt.toolOutputs[0]?.output).toBe('ok');
  });

  it('rejects empty input and emits OpenAI-style SSE frames', () => {
    expect(() => normalizeResponseInput({ input: [] })).toThrow('input must contain');
    const id = newResponseId();
    expect(id).toMatch(/^resp_[0-9a-f]{32}$/);
    const frame = sseEvent({ type: 'response.output_text.delta', item_id: id, delta: 'hi', output_index: 0 });
    expect(frame).toContain('event: response.output_text.delta');
    expect(frame).toContain('"delta":"hi"');
    expect(frame.endsWith('\n\n')).toBe(true);
  });
});
