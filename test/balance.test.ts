import assert from 'node:assert/strict';
import { test } from 'node:test';

import { formatRub, parseKeyInfo, parseMcpBalance } from '../src/balance';

test('reads the account balance from key info', () => {
	assert.deepEqual(parseKeyInfo({ data: { balance_kopecks: 11372, limit_remaining_kopecks: null } }), {
		kopecks: 11372,
		keyLimit: false,
	});
});

test('falls back to the key limit when the key cannot see account money', () => {
	assert.deepEqual(parseKeyInfo({ data: { balance_kopecks: null, limit_remaining_kopecks: 5000 } }), {
		kopecks: 5000,
		keyLimit: true,
	});
	assert.equal(parseKeyInfo({ data: { balance_kopecks: null, limit_remaining_kopecks: null } }), undefined);
});

test('reads balance_get from an SSE reply', () => {
	const raw =
		'event: message\ndata: {"result":{"content":[],"structuredContent":{"balanceRub":"113.72","balanceKopecks":"11372"}},"jsonrpc":"2.0","id":1}\n\n';
	assert.deepEqual(parseMcpBalance(raw), { kopecks: 11372, keyLimit: false });
});

test('reads balance_get from a JSON reply and ignores tool errors', () => {
	assert.deepEqual(parseMcpBalance('{"result":{"structuredContent":{"balanceKopecks":5}}}'), { kopecks: 5, keyLimit: false });
	assert.equal(parseMcpBalance('{"result":{"isError":true,"content":[]}}'), undefined);
	assert.equal(parseMcpBalance('not json'), undefined);
});

test('formats kopecks as rubles', () => {
	assert.equal(formatRub(11372).replace(/\s/g, ' '), '113,72 ₽');
	assert.equal(formatRub(123456789).replace(/\s/g, ' '), '1 234 567,89 ₽');
});
