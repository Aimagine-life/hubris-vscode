// OAuth 2.0 authorization code + PKCE against Hubris, with a loopback redirect (RFC 8252).
// No VS Code imports: the browser is opened through a callback, so tests can drive the flow.

import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export const SCOPES = ['chat:write', 'models:read', 'balance:read'];
const CALLBACK_PATH = '/callback';
// Registered without a port: Hubris matches a loopback address on any port (RFC 8252 §7.3).
const REGISTERED_REDIRECT = `http://127.0.0.1${CALLBACK_PATH}`;
const REFRESH_MARGIN_MS = 60_000;

export interface OAuthTokens {
	clientId: string;
	accessToken: string;
	refreshToken?: string;
	/** Epoch milliseconds. */
	expiresAt: number;
}

export class OAuthError extends Error {
	constructor(
		message: string,
		readonly code?: string,
	) {
		super(message);
	}
}

const b64url = (buf: Buffer) => buf.toString('base64url');

export function createPkce(): { verifier: string; challenge: string } {
	const verifier = b64url(randomBytes(32));
	return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) };
}

export function buildAuthorizeUrl(
	origin: string,
	p: { clientId: string; redirectUri: string; challenge: string; state: string },
): string {
	// encodeURIComponent, not URLSearchParams: a space must travel as %20, since a '+' in the
	// query is not decoded back to a space by every server.
	const q = Object.entries({
		response_type: 'code',
		client_id: p.clientId,
		redirect_uri: p.redirectUri,
		code_challenge: p.challenge,
		code_challenge_method: 'S256',
		scope: [...SCOPES, 'offline_access'].join(' '),
		state: p.state,
	})
		.map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
		.join('&');
	return `${origin}/oauth/authorize?${q}`;
}

async function oauthFailure(res: Response, fallback: string): Promise<OAuthError> {
	const raw = await res.text().catch(() => '');
	try {
		const j = JSON.parse(raw) as { error?: string | { message?: string; code?: string }; error_description?: string };
		if (typeof j.error === 'string') return new OAuthError(j.error_description || j.error, j.error);
		if (j.error?.message) return new OAuthError(j.error.message, j.error.code);
	} catch {
		// plain text body
	}
	return new OAuthError(raw.trim().slice(0, 300) || `${fallback}: HTTP ${res.status}`);
}

export async function registerClient(origin: string, clientName: string): Promise<string> {
	const res = await fetch(`${origin}/oauth/clients`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			client_name: clientName,
			redirect_uris: [REGISTERED_REDIRECT],
			scope: SCOPES.join(' '),
			logo_uri: 'https://hubris.pw/app-icons/icon-192.png',
		}),
	});
	if (!res.ok) throw await oauthFailure(res, 'Client registration failed');
	const body = (await res.json()) as { client_id?: string };
	if (!body.client_id) throw new OAuthError('Client registration returned no client_id');
	return body.client_id;
}

interface TokenResponse {
	access_token?: string;
	refresh_token?: string;
	expires_in?: number;
}

export function toTokens(clientId: string, body: TokenResponse, now = Date.now()): OAuthTokens {
	if (!body.access_token) throw new OAuthError('The token response has no access_token');
	return {
		clientId,
		accessToken: body.access_token,
		refreshToken: body.refresh_token,
		expiresAt: now + (body.expires_in ?? 3600) * 1000,
	};
}

async function tokenRequest(origin: string, form: Record<string, string>): Promise<TokenResponse> {
	const res = await fetch(`${origin}/oauth/token`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams(form).toString(),
	});
	if (!res.ok) throw await oauthFailure(res, 'Token request failed');
	return (await res.json()) as TokenResponse;
}

export function needsRefresh(t: OAuthTokens, now = Date.now()): boolean {
	return t.expiresAt - REFRESH_MARGIN_MS <= now;
}

export async function refreshTokens(origin: string, t: OAuthTokens): Promise<OAuthTokens> {
	if (!t.refreshToken) throw new OAuthError('Sign-in expired', 'invalid_grant');
	const body = await tokenRequest(origin, {
		grant_type: 'refresh_token',
		refresh_token: t.refreshToken,
		client_id: t.clientId,
	});
	return toTokens(t.clientId, body);
}

export interface SignInPages {
	success: string;
	failure: (reason: string) => string;
}

/**
 * Runs the whole browser sign-in: registers a client if needed, waits for the redirect on a local port,
 * exchanges the code. `open` shows the consent page; `signal` cancels the wait.
 */
export async function signIn(opts: {
	origin: string;
	/** A registration from an earlier sign-in; without it a new one is made. */
	clientId?: string;
	clientName: string;
	open: (url: string) => Promise<void>;
	signal: AbortSignal;
	pages: SignInPages;
	timeoutMs?: number;
}): Promise<OAuthTokens> {
	const clientId = opts.clientId ?? (await registerClient(opts.origin, opts.clientName));
	const { verifier, challenge } = createPkce();
	const state = b64url(randomBytes(16));

	let server: Server | undefined;
	try {
		const { code, redirectUri } = await new Promise<{ code: string; redirectUri: string }>((resolve, reject) => {
			let redirectUri = '';
			const timer = setTimeout(() => reject(new OAuthError('Sign-in timed out', 'timeout')), opts.timeoutMs ?? 5 * 60_000);
			const finish = (fn: () => void) => {
				clearTimeout(timer);
				fn();
			};
			opts.signal.addEventListener('abort', () => finish(() => reject(new OAuthError('Sign-in cancelled', 'cancelled'))));

			server = createServer((req, res) => {
				const url = new URL(req.url ?? '/', 'http://127.0.0.1');
				if (url.pathname !== CALLBACK_PATH) {
					res.writeHead(404).end();
					return;
				}
				const send = (status: number, html: string) =>
					res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' }).end(html);
				const error = url.searchParams.get('error');
				const code = url.searchParams.get('code');
				if (url.searchParams.get('state') !== state) {
					send(400, opts.pages.failure('state mismatch'));
					return; // a stray request: keep waiting for the real redirect
				}
				if (error || !code) {
					send(200, opts.pages.failure(error ?? 'no code'));
					finish(() => reject(new OAuthError(error === 'access_denied' ? 'Access was not granted' : `Sign-in failed: ${error}`, error ?? 'no_code')));
					return;
				}
				send(200, opts.pages.success);
				finish(() => resolve({ code, redirectUri }));
			});
			server.on('error', (err) => finish(() => reject(err)));
			server.listen(0, '127.0.0.1', () => {
				const port = (server!.address() as AddressInfo).port;
				redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
				opts
					.open(buildAuthorizeUrl(opts.origin, { clientId, redirectUri, challenge, state }))
					.catch((err) => finish(() => reject(err)));
			});
		});
		const body = await tokenRequest(opts.origin, {
			grant_type: 'authorization_code',
			code,
			redirect_uri: redirectUri,
			client_id: clientId,
			code_verifier: verifier,
		});
		return toTokens(clientId, body);
	} finally {
		server?.close();
	}
}
