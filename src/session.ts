import * as vscode from 'vscode';

import { needsRefresh, OAuthError, refreshTokens, type OAuthTokens } from './oauth';

const KEY_SECRET = 'hubris.apiKey';
const OAUTH_SECRET = 'hubris.oauth';

export type CredentialKind = 'oauth' | 'key' | 'env';

/**
 * Where requests get their bearer token: a browser sign-in first, then a saved API key,
 * then the HUBRIS_API_KEY environment variable. Refreshes the sign-in token when it is near expiry.
 */
export class HubrisSession implements vscode.Disposable {
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChange = this.changed.event;
	private refreshing: Promise<string | undefined> | undefined;
	private readonly sub: vscode.Disposable;

	constructor(
		private readonly secrets: vscode.SecretStorage,
		private readonly state: vscode.Memento,
	) {
		this.sub = secrets.onDidChange((e) => {
			if (e.key === KEY_SECRET || e.key === OAUTH_SECRET) this.changed.fire();
		});
	}

	dispose(): void {
		this.sub.dispose();
		this.changed.dispose();
	}

	/** https://api.hubris.pw (no /v1): the OAuth and MCP endpoints live at the root. */
	origin(): string {
		return new URL(this.baseUrl()).origin;
	}

	baseUrl(): string {
		const url = vscode.workspace.getConfiguration('hubris').get<string>('baseUrl') || 'https://api.hubris.pw/v1';
		return url.replace(/\/+$/, '');
	}

	async kind(): Promise<CredentialKind | undefined> {
		if (await this.secrets.get(OAUTH_SECRET)) return 'oauth';
		if (await this.secrets.get(KEY_SECRET)) return 'key';
		return process.env.HUBRIS_API_KEY?.trim() ? 'env' : undefined;
	}

	async token(): Promise<string | undefined> {
		const oauth = await this.readOAuth();
		if (oauth) return needsRefresh(oauth) ? this.refresh(oauth) : oauth.accessToken;
		return (await this.secrets.get(KEY_SECRET)) || process.env.HUBRIS_API_KEY?.trim() || undefined;
	}

	/** The app registration made at the first sign-in; reused so each install registers once. */
	knownClientId(): string | undefined {
		return this.state.get<string>(`hubris.oauthClient:${this.origin()}`);
	}

	async rememberClientId(id: string | undefined): Promise<void> {
		await this.state.update(`hubris.oauthClient:${this.origin()}`, id);
	}

	async saveOAuth(t: OAuthTokens): Promise<void> {
		await this.secrets.store(OAUTH_SECRET, JSON.stringify(t));
	}

	async saveKey(key: string): Promise<void> {
		await this.secrets.store(KEY_SECRET, key);
	}

	async signOut(): Promise<void> {
		await this.secrets.delete(OAUTH_SECRET);
		await this.secrets.delete(KEY_SECRET);
	}

	private async readOAuth(): Promise<OAuthTokens | undefined> {
		const raw = await this.secrets.get(OAUTH_SECRET);
		if (!raw) return undefined;
		try {
			return JSON.parse(raw) as OAuthTokens;
		} catch {
			await this.secrets.delete(OAUTH_SECRET);
			return undefined;
		}
	}

	/** One refresh at a time: parallel requests share the result (Hubris rotates refresh tokens). */
	private refresh(t: OAuthTokens): Promise<string | undefined> {
		this.refreshing ??= (async () => {
			try {
				const next = await refreshTokens(this.origin(), t);
				await this.saveOAuth(next);
				return next.accessToken;
			} catch (err) {
				if (err instanceof OAuthError && (err.code === 'invalid_grant' || err.code === 'invalid_client')) {
					await this.secrets.delete(OAUTH_SECRET);
					void vscode.window
						.showWarningMessage(vscode.l10n.t('Your Hubris sign-in has expired.'), vscode.l10n.t('Sign in'))
						.then((pick) => pick && vscode.commands.executeCommand('hubris.signIn'));
					return undefined;
				}
				throw err;
			} finally {
				this.refreshing = undefined;
			}
		})();
		return this.refreshing;
	}
}
