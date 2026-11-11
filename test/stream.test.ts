import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ChatStreamParser, StreamError, type StreamEvent } from '../src/stream';

const line = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
const delta = (d: object, finish: string | null = null) => line({ choices: [{ delta: d, finish_reason: finish }] });

function feed(pieces: string[]): StreamEvent[] {
	const p = new ChatStreamParser();
	return [...pieces.flatMap((x) => p.push(x)), ...p.end()];
}

test('emits text deltas in order', () => {
	const events = feed([delta({ content: 'Hel' }), delta({ content: 'lo' }), 'data: [DONE]\n\n']);
	assert.deepEqual(events, [
		{ type: 'text', text: 'Hel' },
		{ type: 'text', text: 'lo' },
	]);
});

test('joins lines split across network chunks', () => {
	const full = delta({ content: 'привет' });
	const events = feed([full.slice(0, 15), full.slice(15)]);
	assert.deepEqual(events, [{ type: 'text', text: 'привет' }]);
});

test('assembles tool call arguments from fragments and emits on finish', () => {
	const events = feed([
		delta({ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{"pa' } }] }),
		delta({ tool_calls: [{ index: 0, function: { arguments: 'th":"a.txt"}' } }] }),
		delta({}, 'tool_calls'),
		'data: [DONE]\n\n',
	]);
	assert.deepEqual(events, [{ type: 'tool_call', id: 'call_1', name: 'read_file', input: { path: 'a.txt' } }]);
});

test('keeps parallel tool calls apart by index', () => {
	const events = feed([
		delta({ tool_calls: [{ index: 1, id: 'b', function: { name: 'two', arguments: '{}' } }] }),
		delta({ tool_calls: [{ index: 0, id: 'a', function: { name: 'one', arguments: '{"x":1}' } }] }),
		'data: [DONE]\n\n',
	]);
	assert.deepEqual(
		events.map((e) => (e.type === 'tool_call' ? e.name : '')),
		['one', 'two'],
	);
});

test('emits pending tool calls when the stream ends without [DONE]', () => {
	const events = feed([delta({ tool_calls: [{ index: 0, id: 'c', function: { name: 'now', arguments: '' } }] })]);
	assert.deepEqual(events, [{ type: 'tool_call', id: 'c', name: 'now', input: {} }]);
});

test('ignores comments, keep-alives and the usage chunk', () => {
	const events = feed([': ping\n\n', 'data: \n\n', line({ choices: [], usage: { prompt_tokens: 3 } }), delta({ content: 'ok' })]);
	assert.deepEqual(events, [{ type: 'text', text: 'ok' }]);
});

test('raises the error the gateway sends inside the stream', () => {
	const p = new ChatStreamParser();
	assert.throws(() => p.push(line({ error: { message: 'Недостаточно средств' } })), (e: unknown) => {
		return e instanceof StreamError && e.message === 'Недостаточно средств';
	});
});

test('raises a clear error when tool arguments are not JSON', () => {
	const p = new ChatStreamParser();
	p.push(delta({ tool_calls: [{ index: 0, id: 'c', function: { name: 'f', arguments: '{oops' } }] }));
	assert.throws(() => p.end(), StreamError);
});
