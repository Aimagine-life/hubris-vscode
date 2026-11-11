import * as vscode from 'vscode';

import {
	estimateTokens,
	isChatModel,
	toModelInfo,
	toOpenAIMessages,
	toOpenAITools,
	type HubrisModel,
	type InputMessage,
	type ModelInfo,
} from './convert';
import type { HubrisSession } from './session';
import { ChatStreamParser, type StreamEvent } from './stream';

const MODEL_CACHE_MS = 10 * 60 * 1000;
export const TOP_UP_PAGE = 'https://hubris.pw/billing';

export class HubrisChatProvider implements vscode.LanguageModelChatProvider<ModelInfo> {
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChangeLanguageModelChatInformation = this.changed.event;
	private readonly answered = new vscode.EventEmitter<void>();
	/** Fires after each finished or failed request: the balance may have changed. */
	readonly onDidAnswer = this.answered.event;
	private cache: { at: number; token: string; models: ModelInfo[] } | undefined;

	constructor(
		private readonly session: HubrisSession,
		private readonly userAgent: string,
		private readonly askToConnect: () => Promise<boolean>,
	) {}

	/** Drops the cached model list and tells VS Code to ask again (sign-in or settings changed). */
	refresh(): void {
		this.cache = undefined;
		this.changed.fire();
	}

	async provideLanguageModelChatInformation(
		options: vscode.PrepareLanguageModelChatModelOptions,
		token: vscode.CancellationToken,
	): Promise<ModelInfo[]> {
		let bearer = await this.session.token();
		if (!bearer && !options.silent && (await this.askToConnect())) bearer = await this.session.token();
		if (!bearer) return [];
		if (this.cache && this.cache.token === bearer && Date.now() - this.cache.at < MODEL_CACHE_MS) {
			return this.filtered(this.cache.models);
		}
		const controller = new AbortController();
		const sub = token.onCancellationRequested(() => controller.abort());
		try {
			const res = await fetch(`${this.session.baseUrl()}/models`, {
				headers: { Authorization: `Bearer ${bearer}`, 'User-Agent': this.userAgent },
				signal: controller.signal,
			});
			if (!res.ok) throw new Error((await readError(res)).message);
			const body = (await res.json()) as { data?: HubrisModel[] };
			const labels = {
				free: vscode.l10n.t('Free'),
				perMillion: vscode.l10n.t('per 1M tokens, input / output'),
			};
			const models = (body.data ?? [])
				.filter(isChatModel)
				.map((m) => toModelInfo(m, labels))
				.sort((a, b) => a.family.localeCompare(b.family) || a.name.localeCompare(b.name));
			this.cache = { at: Date.now(), token: bearer, models };
			return this.filtered(models);
		} catch (err) {
			if (!options.silent && !token.isCancellationRequested) {
				void vscode.window.showErrorMessage(
					vscode.l10n.t('Hubris: could not load the model list. {0}', describe(err)),
				);
			}
			return [];
		} finally {
			sub.dispose();
		}
	}

	private filtered(models: ModelInfo[]): ModelInfo[] {
		const wanted = vscode.workspace.getConfiguration('hubris').get<string[]>('models') ?? [];
		if (!wanted.length) return models;
		const set = new Set(wanted);
		return models.filter((m) => set.has(m.id));
	}

	async provideLanguageModelChatResponse(
		model: ModelInfo,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken,
	): Promise<void> {
		const bearer = await this.session.token();
		if (!bearer) throw new Error(vscode.l10n.t('You are not signed in to Hubris. Run "Hubris: Sign In".'));

		const tools = toOpenAITools(options.tools);
		const body: Record<string, unknown> = {
			model: model.id,
			messages: toOpenAIMessages(messages as readonly InputMessage[], model.id.startsWith('anthropic/')),
			stream: true,
			stream_options: { include_usage: true },
		};
		if (tools) {
			body.tools = tools;
			if (options.toolMode === vscode.LanguageModelChatToolMode.Required) {
				body.tool_choice = tools.length === 1 ? { type: 'function', function: { name: tools[0].function.name } } : 'required';
			}
		}
		const temperature = options.modelOptions?.temperature;
		if (typeof temperature === 'number') body.temperature = temperature;

		const controller = new AbortController();
		const sub = token.onCancellationRequested(() => controller.abort());
		try {
			const res = await fetch(`${this.session.baseUrl()}/chat/completions`, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${bearer}`,
					'Content-Type': 'application/json',
					Accept: 'text/event-stream',
					'User-Agent': this.userAgent,
				},
				body: JSON.stringify(body),
				signal: controller.signal,
			});
			if (!res.ok) throw await this.requestError(res);
			if (!res.body) throw new Error(vscode.l10n.t('Hubris returned an empty response.'));

			const parser = new ChatStreamParser();
			const decoder = new TextDecoder();
			const emit = (events: StreamEvent[]) => {
				for (const e of events) {
					progress.report(
						e.type === 'text'
							? new vscode.LanguageModelTextPart(e.text)
							: new vscode.LanguageModelToolCallPart(e.id, e.name, e.input),
					);
				}
			};
			for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
				emit(parser.push(decoder.decode(chunk, { stream: true })));
			}
			emit(parser.push(decoder.decode()));
			emit(parser.end());
		} catch (err) {
			if (token.isCancellationRequested) return;
			throw err instanceof Error ? err : new Error(String(err));
		} finally {
			sub.dispose();
			this.answered.fire();
		}
	}

	/** Turns an HTTP error into a chat error; offers the fix for the two errors the user can fix. */
	private async requestError(res: Response): Promise<Error> {
		const e = await readError(res);
		if (res.status === 401) {
			void vscode.window
				.showErrorMessage(vscode.l10n.t('Hubris did not accept your sign-in.'), vscode.l10n.t('Sign in'))
				.then((pick) => pick && vscode.commands.executeCommand('hubris.signIn'));
			return new Error(vscode.l10n.t('Hubris did not accept your sign-in. Run "Hubris: Sign In".'));
		}
		if (res.status === 402 || e.code === 'insufficient_balance') {
			void vscode.window
				.showErrorMessage(e.message, vscode.l10n.t('Top up'))
				.then((pick) => {
					if (pick) void vscode.env.openExternal(vscode.Uri.parse(TOP_UP_PAGE));
				});
		}
		return new Error(e.message);
	}

	async provideTokenCount(
		_model: ModelInfo,
		text: string | vscode.LanguageModelChatRequestMessage,
	): Promise<number> {
		return estimateTokens(text as string | InputMessage);
	}
}

async function readError(res: Response): Promise<{ message: string; code?: string }> {
	const raw = await res.text().catch(() => '');
	try {
		const parsed = JSON.parse(raw) as { error?: { message?: string; code?: string } };
		if (parsed.error?.message) return { message: parsed.error.message, code: parsed.error.code };
	} catch {
		// not JSON: fall through to the status line
	}
	return { message: `HTTP ${res.status} ${res.statusText}`.trim() };
}

function describe(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
