import * as vscode from 'vscode';

import { fetchBalance, formatRub } from './balance';
import { OAuthError, signIn } from './oauth';
import { HubrisChatProvider, TOP_UP_PAGE } from './provider';
import { HubrisSession } from './session';

const KEY_PAGE = 'https://hubris.pw/keys';
const USAGE_PAGE = 'https://hubris.pw/usage';
const BALANCE_EVERY_MS = 5 * 60 * 1000;
// Chat: Manage Language Models.
const MANAGE_MODELS = 'workbench.action.chat.manage';

export function activate(context: vscode.ExtensionContext): void {
	const version = (context.extension.packageJSON as { version?: string }).version ?? 'unknown';
	const userAgent = `hubris-vscode/${version} VSCode/${vscode.version}`;

	const session = new HubrisSession(context.secrets);
	const provider = new HubrisChatProvider(session, userAgent, () => connect(session));
	const status = new BalanceStatus(session, userAgent);

	context.subscriptions.push(
		session,
		status,
		vscode.lm.registerLanguageModelChatProvider('hubris', provider),
		vscode.commands.registerCommand('hubris.signIn', () => browserSignIn(session)),
		vscode.commands.registerCommand('hubris.setApiKey', () => askForKey(session)),
		vscode.commands.registerCommand('hubris.signOut', () => signOut(session)),
		vscode.commands.registerCommand('hubris.manage', () => manage(session, provider, status)),
		session.onDidChange(() => {
			provider.refresh();
			status.update();
		}),
		provider.onDidAnswer(() => status.update(3_000)),
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('hubris')) {
				provider.refresh();
				status.update();
			}
		}),
	);
	status.update();
}

/** Asked by the model picker when nothing is connected yet. Returns true when a credential was saved. */
async function connect(session: HubrisSession): Promise<boolean> {
	const items: (vscode.QuickPickItem & { run: () => Promise<boolean> })[] = [
		{
			label: `$(sign-in) ${vscode.l10n.t('Sign in with the browser')}`,
			detail: vscode.l10n.t('Confirm access on hubris.pw, no key to copy'),
			run: () => browserSignIn(session),
		},
		{
			label: `$(key) ${vscode.l10n.t('Use an API key')}`,
			detail: vscode.l10n.t('Paste a key that starts with sk-gw-'),
			run: () => askForKey(session),
		},
	];
	const pick = await vscode.window.showQuickPick(items, { title: vscode.l10n.t('Connect Hubris') });
	return pick ? pick.run() : false;
}

async function browserSignIn(session: HubrisSession): Promise<boolean> {
	try {
		const tokens = await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: vscode.l10n.t('Hubris: confirm access in the browser…'),
				cancellable: true,
			},
			(_progress, cancel) => {
				const abort = new AbortController();
				cancel.onCancellationRequested(() => abort.abort());
				return signIn({
					origin: session.origin(),
					clientName: `VS Code (${vscode.env.appName})`,
					open: async (url) => {
						// openExternal hands the browser the decoded query; it still parses, because
						// no value here (UUID, base64url, loopback address, scope names) holds & or =.
						if (!(await vscode.env.openExternal(vscode.Uri.parse(url, true)))) {
							throw new OAuthError('The browser did not open', 'no_browser');
						}
					},
					signal: abort.signal,
					pages: {
						success: page(vscode.l10n.t('Hubris is connected'), vscode.l10n.t('You can close this tab and return to VS Code.')),
						failure: (reason) => page(vscode.l10n.t('Hubris was not connected'), reason),
					},
				});
			},
		);
		await session.saveOAuth(tokens);
		offerModelPicker(vscode.l10n.t('Hubris is connected.'));
		return true;
	} catch (err) {
		if (err instanceof OAuthError && err.code === 'cancelled') return false;
		const message = err instanceof Error ? err.message : String(err);
		const pick = await vscode.window.showErrorMessage(
			vscode.l10n.t('Hubris: sign-in failed. {0}', message),
			vscode.l10n.t('Use an API key'),
		);
		return pick ? askForKey(session) : false;
	}
}

async function askForKey(session: HubrisSession): Promise<boolean> {
	const value = await vscode.window.showInputBox({
		title: vscode.l10n.t('Hubris API Key'),
		prompt: vscode.l10n.t('Paste your Hubris API key. You can create one at {0}', KEY_PAGE),
		placeHolder: 'sk-gw-...',
		password: true,
		ignoreFocusOut: true,
		validateInput: (v) => (v.trim().startsWith('sk-gw-') ? undefined : vscode.l10n.t('A Hubris key starts with sk-gw-')),
	});
	if (!value?.trim()) return false;
	await session.saveKey(value.trim());
	offerModelPicker(vscode.l10n.t('Hubris API key saved.'));
	return true;
}

/** VS Code keeps provider models out of the picker until the user turns them on, so point there. */
function offerModelPicker(done: string): void {
	const choose = vscode.l10n.t('Choose models');
	void vscode.window
		.showInformationMessage(
			`${done} ${vscode.l10n.t('Turn on the Hubris models you need in Manage Language Models (the eye icon).')}`,
			choose,
		)
		.then((pick) => {
			if (pick === choose) void vscode.commands.executeCommand(MANAGE_MODELS);
		});
}

async function signOut(session: HubrisSession): Promise<void> {
	await session.signOut();
	void vscode.window.showInformationMessage(vscode.l10n.t('Signed out of Hubris.'));
}

async function manage(session: HubrisSession, provider: HubrisChatProvider, status: BalanceStatus): Promise<void> {
	const kind = await session.kind();
	type Item = vscode.QuickPickItem & { run?: () => unknown };
	const open = (url: string) => () => vscode.env.openExternal(vscode.Uri.parse(url));
	const items: Item[] = kind
		? [
				{ label: `$(credit-card) ${vscode.l10n.t('Top up balance')}`, description: status.text(), run: open(TOP_UP_PAGE) },
				{ label: `$(graph) ${vscode.l10n.t('Usage and spending')}`, run: open(USAGE_PAGE) },
				{ label: `$(list-selection) ${vscode.l10n.t('Choose models for the chat')}`, run: () => vscode.commands.executeCommand(MANAGE_MODELS) },
				{ label: `$(refresh) ${vscode.l10n.t('Reload the model list')}`, run: () => provider.refresh() },
				{ label: '', kind: vscode.QuickPickItemKind.Separator },
				kind === 'oauth'
					? { label: `$(key) ${vscode.l10n.t('Use an API key instead')}`, run: () => askForKey(session) }
					: { label: `$(sign-in) ${vscode.l10n.t('Sign in with the browser instead')}`, run: () => browserSignIn(session) },
				...(kind === 'env'
					? []
					: [{ label: `$(sign-out) ${vscode.l10n.t('Sign out')}`, run: () => signOut(session) }]),
			]
		: [
				{ label: `$(sign-in) ${vscode.l10n.t('Sign in with the browser')}`, run: () => browserSignIn(session) },
				{ label: `$(key) ${vscode.l10n.t('Use an API key')}`, run: () => askForKey(session) },
				{ label: `$(link-external) ${vscode.l10n.t('Create a key on hubris.pw')}`, run: open(KEY_PAGE) },
			];
	const pick = await vscode.window.showQuickPick(items, { title: 'Hubris' });
	await pick?.run?.();
}

/** Status bar entry with the balance, like the account panel of an IDE agent. Click opens the menu. */
class BalanceStatus implements vscode.Disposable {
	private readonly item = vscode.window.createStatusBarItem('hubris.balance', vscode.StatusBarAlignment.Right, 100);
	private timer: NodeJS.Timeout | undefined;
	private readonly interval = setInterval(() => this.update(), BALANCE_EVERY_MS);
	private last = '';

	constructor(
		private readonly session: HubrisSession,
		private readonly userAgent: string,
	) {
		this.item.name = 'Hubris';
		this.item.command = 'hubris.manage';
	}

	text(): string {
		return this.last;
	}

	/** Schedules a refresh; repeated calls within the delay collapse into one request. */
	update(delayMs = 0): void {
		clearTimeout(this.timer);
		this.timer = setTimeout(() => void this.refresh(), delayMs);
	}

	private async refresh(): Promise<void> {
		if (!vscode.workspace.getConfiguration('hubris').get<boolean>('showBalance', true)) {
			this.item.hide();
			return;
		}
		const kind = await this.session.kind();
		const token = kind && (await this.session.token().catch(() => undefined));
		if (!kind || !token) {
			this.last = '';
			this.item.text = `$(sign-in) Hubris`;
			this.item.tooltip = vscode.l10n.t('Connect Hubris to use its models in the chat');
			this.item.show();
			return;
		}
		try {
			const b = await fetchBalance(this.session.baseUrl(), this.session.origin(), token, kind, this.userAgent);
			if (!b) throw new Error('no balance');
			this.last = formatRub(b.kopecks);
			this.item.text = `Hubris ${this.last}`;
			this.item.tooltip = b.keyLimit
				? vscode.l10n.t('Hubris: left on this key today. Click for the menu.')
				: vscode.l10n.t('Hubris balance. Click to top up or manage the connection.');
		} catch {
			this.item.text = 'Hubris';
			this.item.tooltip = vscode.l10n.t('Hubris: the balance is not available right now. Click for the menu.');
		}
		this.item.show();
	}

	dispose(): void {
		clearTimeout(this.timer);
		clearInterval(this.interval);
		this.item.dispose();
	}
}

function page(title: string, text: string): string {
	const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
	return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font-family:Inter,system-ui,sans-serif;background:#0e0d1a;color:#ece9ff;display:grid;place-items:center;min-height:100vh;margin:0}
main{max-width:420px;padding:32px;text-align:center}h1{font-size:22px;margin:0 0 12px}p{color:#b9b4d6;line-height:1.5;margin:0}</style></head>
<body><main><h1>${esc(title)}</h1><p>${esc(text)}</p></main></body></html>`;
}

export function deactivate(): void {}
