import assert from 'node:assert/strict';
import { test } from 'node:test';

import { estimateTokens, isChatModel, toModelInfo, toOpenAIMessages, toOpenAITools } from '../src/convert';

// Plain objects shaped like the VS Code part classes.
const text = (value: string) => ({ value });
const call = (callId: string, name: string, input: object) => ({ callId, name, input });
const result = (callId: string, content: unknown[]) => ({ callId, content });
const data = (mimeType: string, bytes: string) => ({ mimeType, data: new TextEncoder().encode(bytes) });

test('keeps only text models that can call tools', () => {
	assert.equal(isChatModel({ id: 'a/chat', output_modalities: ['text'], supported_parameters: ['tools'] }), true);
	assert.equal(isChatModel({ id: 'a/notools', output_modalities: ['text'], supported_parameters: ['stop'] }), false);
	assert.equal(isChatModel({ id: 'a/img', output_modalities: ['image'], supported_parameters: ['tools'] }), false);
});

test('maps catalogue fields to model information', () => {
	const info = toModelInfo({
		id: 'anthropic/claude-sonnet-5',
		display_name: 'Anthropic: Claude Sonnet 5',
		owned_by: 'anthropic',
		context_length: 1_000_000,
		input_modalities: ['text', 'image'],
		supported_parameters: ['tools'],
		pricing: { input_rub_per_million: 252.48, output_rub_per_million: 1262.37 },
	});
	assert.equal(info.name, 'Claude Sonnet 5');
	assert.equal(info.family, 'anthropic');
	assert.equal(info.maxOutputTokens, 32_768);
	assert.equal(info.maxInputTokens, 1_000_000 - 32_768);
	assert.deepEqual(info.capabilities, { imageInput: true, toolCalling: true });
	assert.match(info.tooltip, /252,48 ₽ \/ 1\s262,37 ₽/);
});

test('falls back to a default context when the catalogue has none', () => {
	const info = toModelInfo({ id: 'x/y' });
	assert.equal(info.maxInputTokens + info.maxOutputTokens, 128_000);
	assert.equal(info.name, 'x/y');
});

test('turns system, user and assistant text into OpenAI messages', () => {
	const out = toOpenAIMessages(
		[
			{ role: 3, content: [text('be brief')] },
			{ role: 1, content: [text('hi')] },
			{ role: 2, content: [text('hello')] },
		],
		false,
	);
	assert.deepEqual(out, [
		{ role: 'system', content: 'be brief' },
		{ role: 'user', content: [{ type: 'text', text: 'hi' }] },
		{ role: 'assistant', content: 'hello' },
	]);
});

test('puts tool results right after the assistant tool call as tool messages', () => {
	const out = toOpenAIMessages(
		[
			{ role: 1, content: [text('read a.txt')] },
			{ role: 2, content: [call('c1', 'read_file', { path: 'a.txt' })] },
			{ role: 1, content: [result('c1', [text('file body')]), text('now summarise')] },
		],
		false,
	);
	assert.deepEqual(out[1], {
		role: 'assistant',
		content: null,
		tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }],
	});
	assert.deepEqual(out[2], { role: 'tool', tool_call_id: 'c1', content: 'file body' });
	assert.deepEqual(out[3], { role: 'user', content: [{ type: 'text', text: 'now summarise' }] });
});

test('sends images as data URLs and keeps text data parts in tool results', () => {
	const out = toOpenAIMessages(
		[
			{ role: 1, content: [text('what is this?'), data('image/png', 'PNG')] },
			{ role: 1, content: [result('c2', [data('application/json', '{"ok":true}'), data('image/png', 'x')])] },
		],
		false,
	);
	assert.deepEqual(out[0], {
		role: 'user',
		content: [
			{ type: 'text', text: 'what is this?' },
			{ type: 'image_url', image_url: { url: 'data:image/png;base64,UE5H' } },
		],
	});
	assert.deepEqual(out[1], { role: 'tool', tool_call_id: 'c2', content: '{"ok":true}[image omitted]' });
});

test('turns cache markers into cache_control only when asked', () => {
	const msgs = [{ role: 1, content: [text('long context'), data('cache_control', 'ephemeral')] }];
	assert.deepEqual(toOpenAIMessages(msgs, true)[0], {
		role: 'user',
		content: [{ type: 'text', text: 'long context', cache_control: { type: 'ephemeral' } }],
	});
	assert.deepEqual(toOpenAIMessages(msgs, false)[0], {
		role: 'user',
		content: [{ type: 'text', text: 'long context' }],
	});
});

test('drops empty messages', () => {
	assert.deepEqual(toOpenAIMessages([{ role: 2, content: [] }, { role: 1, content: [text('')] }], false), []);
});

test('gives tools without a schema an empty object schema', () => {
	assert.equal(toOpenAITools([]), undefined);
	assert.deepEqual(toOpenAITools([{ name: 'now', description: 'time' }]), [
		{ type: 'function', function: { name: 'now', description: 'time', parameters: { type: 'object', properties: {} } } },
	]);
});

test('estimates tokens from text length and images', () => {
	assert.equal(estimateTokens('abcdefgh'), 2);
	assert.equal(estimateTokens({ role: 1, content: [text('abcd'), data('image/png', 'x')] }), 1_001);
});
