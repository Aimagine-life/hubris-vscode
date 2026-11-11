import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';

import { buildAuthorizeUrl, createPkce, needsRefresh, OAuthError, refreshTokens, signIn } from '../src/oauth';

const pages = { success: 'ok', failure: (r: string) => `fail ${r}` };

const readBody = (req: IncomingMessage) =>
	new Promise<string>((resolve) => {
		let s = '';
		req.on('data', (d) => (s += d)).on('end', () => resolve(s));
	});

/** A stand-in for the Hubris OAuth endpoints that records what the client sent. */
async function fakeHubris(tokenStatus = 200) {
	const seen: { registration?: Record<string, unknown>; token?: URLSearchParams; challenge?: string } = {};
	const server = createServer(async (req, res) => {
		const body = await readBody(req);
		if (req.url === '/oauth/clients') {
			seen.registration = JSON.parse(body);
			res.writeHead(201, { 'Content-Type': 'application/json' }).end(JSON.stringify({ client_id: 'cid-1' }));
		} else if (req.url === '/oauth/token') {
			seen.token = new URLSearchParams(body);
			if (tokenStatus !== 200) {
				res.writeHead(tokenStatus, { 'Content-Type': 'application/json' }).end(
					JSON.stringify({ error: 'invalid_grant', error_description: 'Код авторизации не найден' }),
				);
				return;
			}
			res.writeHead(200, { 'Content-Type': 'application/json' }).end(
				JSON.stringify({ access_token: 'hbr-at-1', refresh_token: 'hbr-rt-1', expires_in: 3600 }),
			);
		} else {
			res.writeHead(404).end();
		}
	});
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
	const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	return { origin, seen, close: () => server.close() };
}

/** Plays the browser: follows the authorize URL straight back to the redirect with a code. */
function approve(code = 'the-code', overrides: Record<string, string> = {}) {
	return async (url: string) => {
		const u = new URL(url);
		const back = new URL(u.searchParams.get('redirect_uri')!);
		back.searchParams.set('code', code);
		back.searchParams.set('state', u.searchParams.get('state')!);
		for (const [k, v] of Object.entries(overrides)) back.searchParams.set(k, v);
		const res = await fetch(back);
		await res.text();
	};
}

test('PKCE challenge is the S256 hash of the verifier', () => {
	const { verifier, challenge } = createPkce();
	assert.equal(challenge, createHash('sha256').update(verifier).digest('base64url'));
	assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
});

test('authorize URL encodes spaces as %20 and asks for offline access', () => {
	const url = buildAuthorizeUrl('https://api.hubris.pw', {
		clientId: 'c',
		redirectUri: 'http://127.0.0.1:5000/callback',
		challenge: 'ch',
		state: 's',
	});
	assert.ok(url.startsWith('https://api.hubris.pw/oauth/authorize?response_type=code&'));
	assert.ok(url.includes('scope=chat%3Awrite%20models%3Aread%20balance%3Aread%20offline_access'));
	assert.ok(url.includes('redirect_uri=http%3A%2F%2F127.0.0.1%3A5000%2Fcallback'));
	assert.ok(!url.includes('+'));
});

test('signs in: registers a loopback client and exchanges the code with the verifier', async () => {
	const hub = await fakeHubris();
	try {
		let challenge = '';
		const tokens = await signIn({
			origin: hub.origin,
			clientName: 'VS Code',
			open: async (url) => {
				challenge = new URL(url).searchParams.get('code_challenge')!;
				await approve()(url);
			},
			signal: new AbortController().signal,
			pages,
		});
		assert.deepEqual(hub.seen.registration?.redirect_uris, ['http://127.0.0.1/callback']);
		assert.equal(hub.seen.token?.get('grant_type'), 'authorization_code');
		assert.equal(hub.seen.token?.get('code'), 'the-code');
		assert.match(hub.seen.token?.get('redirect_uri') ?? '', /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
		const verifier = hub.seen.token?.get('code_verifier') ?? '';
		assert.equal(createHash('sha256').update(verifier).digest('base64url'), challenge);
		assert.equal(tokens.clientId, 'cid-1');
		assert.equal(tokens.accessToken, 'hbr-at-1');
		assert.equal(tokens.refreshToken, 'hbr-rt-1');
	} finally {
		hub.close();
	}
});

test('rejects when the user denies access', async () => {
	const hub = await fakeHubris();
	try {
		await assert.rejects(
			signIn({
				origin: hub.origin,
				clientName: 'VS Code',
				open: approve('', { error: 'access_denied' }),
				signal: new AbortController().signal,
				pages,
			}),
			(e: unknown) => e instanceof OAuthError && e.code === 'access_denied',
		);
	} finally {
		hub.close();
	}
});

test('stops waiting when cancelled', async () => {
	const hub = await fakeHubris();
	const abort = new AbortController();
	try {
		await assert.rejects(
			signIn({ origin: hub.origin, clientName: 'VS Code', open: async () => abort.abort(), signal: abort.signal, pages }),
			(e: unknown) => e instanceof OAuthError && e.code === 'cancelled',
		);
	} finally {
		hub.close();
	}
});

test('refresh sends the refresh token and reports invalid_grant by code', async () => {
	const ok = await fakeHubris();
	try {
		const next = await refreshTokens(ok.origin, { clientId: 'cid-1', accessToken: 'old', refreshToken: 'hbr-rt-0', expiresAt: 0 });
		assert.equal(ok.seen.token?.get('grant_type'), 'refresh_token');
		assert.equal(ok.seen.token?.get('refresh_token'), 'hbr-rt-0');
		assert.equal(next.accessToken, 'hbr-at-1');
	} finally {
		ok.close();
	}
	const bad = await fakeHubris(400);
	try {
		await assert.rejects(
			refreshTokens(bad.origin, { clientId: 'c', accessToken: 'a', refreshToken: 'r', expiresAt: 0 }),
			(e: unknown) => e instanceof OAuthError && e.code === 'invalid_grant' && e.message === 'Код авторизации не найден',
		);
	} finally {
		bad.close();
	}
});

test('refreshes a minute before expiry', () => {
	const now = 1_000_000;
	assert.equal(needsRefresh({ clientId: 'c', accessToken: 'a', expiresAt: now + 120_000 }, now), false);
	assert.equal(needsRefresh({ clientId: 'c', accessToken: 'a', expiresAt: now + 30_000 }, now), true);
});
