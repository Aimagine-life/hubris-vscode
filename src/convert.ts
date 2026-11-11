// Pure conversion between VS Code chat parts and the OpenAI Chat Completions format.
// Parts are recognised by shape, not by class, so this module runs without VS Code (tests).

export interface HubrisModel {
	id: string;
	display_name?: string;
	owned_by?: string;
	description?: string;
	context_length?: number;
	input_modalities?: string[];
	output_modalities?: string[];
	supported_parameters?: string[];
	pricing?: { input_rub_per_million?: number; output_rub_per_million?: number; is_free?: boolean };
}

export interface ModelInfo {
	id: string;
	name: string;
	family: string;
	tooltip: string;
	detail: string;
	version: string;
	maxInputTokens: number;
	maxOutputTokens: number;
	capabilities: { imageInput: boolean; toolCalling: boolean };
}

export type OpenAIContentPart =
	| { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }
	| { type: 'image_url'; image_url: { url: string } };

export interface OpenAIToolCall {
	id: string;
	type: 'function';
	function: { name: string; arguments: string };
}

export type OpenAIMessage =
	| { role: 'system'; content: string }
	| { role: 'user'; content: OpenAIContentPart[] }
	| { role: 'assistant'; content: string | null; tool_calls?: OpenAIToolCall[] }
	| { role: 'tool'; tool_call_id: string; content: string };

export interface OpenAITool {
	type: 'function';
	function: { name: string; description: string; parameters: object };
}

const DEFAULT_CONTEXT = 128_000;
const MAX_OUTPUT_CAP = 32_768;

// Roles as numbers: User = 1, Assistant = 2; Copilot sends its system prompt with 3.
const ROLE_USER = 1;
const ROLE_ASSISTANT = 2;
const ROLE_SYSTEM = 3;

export function isChatModel(m: HubrisModel): boolean {
	const out = m.output_modalities ?? ['text'];
	return out.includes('text') && (m.supported_parameters ?? []).includes('tools');
}

const rub = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });

export interface PriceLabels {
	free: string;
	perMillion: string;
}

const EN_LABELS: PriceLabels = { free: 'Free', perMillion: 'per 1M tokens, input / output' };

export function toModelInfo(m: HubrisModel, labels: PriceLabels = EN_LABELS): ModelInfo {
	const context = m.context_length && m.context_length > 0 ? m.context_length : DEFAULT_CONTEXT;
	const maxOutputTokens = Math.min(MAX_OUTPUT_CAP, Math.floor(context / 4));
	const name = (m.display_name ?? m.id).replace(/^[^:]+:\s*/, '');
	const p = m.pricing;
	const price = p?.is_free
		? labels.free
		: p?.input_rub_per_million !== undefined && p.output_rub_per_million !== undefined
			? `${rub.format(p.input_rub_per_million)} ₽ / ${rub.format(p.output_rub_per_million)} ₽ ${labels.perMillion}`
			: '';
	return {
		id: m.id,
		name,
		family: m.owned_by ?? m.id.split('/')[0],
		tooltip: [m.id, price].filter(Boolean).join('\n'),
		detail: 'Hubris',
		version: '1',
		maxInputTokens: context - maxOutputTokens,
		maxOutputTokens,
		capabilities: {
			imageInput: (m.input_modalities ?? []).includes('image'),
			toolCalling: true,
		},
	};
}

interface TextLike { value: string }
interface DataLike { mimeType: string; data: Uint8Array }
interface ToolCallLike { callId: string; name: string; input: unknown }
interface ToolResultLike { callId: string; content: readonly unknown[] }

const isObj = (p: unknown): p is Record<string, unknown> => typeof p === 'object' && p !== null;
const isText = (p: unknown): p is TextLike => isObj(p) && typeof p.value === 'string';
const isData = (p: unknown): p is DataLike =>
	isObj(p) && typeof p.mimeType === 'string' && p.data instanceof Uint8Array;
const isToolCall = (p: unknown): p is ToolCallLike =>
	isObj(p) && typeof p.callId === 'string' && typeof p.name === 'string' && 'input' in p;
const isToolResult = (p: unknown): p is ToolResultLike =>
	isObj(p) && typeof p.callId === 'string' && Array.isArray(p.content);

const decoder = new TextDecoder();

function toolResultText(content: readonly unknown[]): string {
	const out: string[] = [];
	for (const part of content) {
		if (isText(part)) {
			out.push(part.value);
		} else if (isData(part) && (part.mimeType.startsWith('text/') || part.mimeType.includes('json'))) {
			out.push(decoder.decode(part.data));
		} else if (isData(part) && part.mimeType.startsWith('image/')) {
			out.push('[image omitted]');
		} else if (isObj(part) && 'value' in part) {
			// LanguageModelPromptTsxPart: an opaque prompt element; JSON keeps its text.
			out.push(JSON.stringify(part.value));
		}
	}
	return out.join('');
}

export interface InputMessage {
	role: number;
	content: readonly unknown[];
}

/**
 * Converts VS Code messages to OpenAI messages. Tool results that VS Code puts into a user
 * message become `tool` messages, which OpenAI requires right after the assistant's tool calls.
 * `cacheHints` turns Copilot's cache markers into Anthropic-style `cache_control`.
 */
export function toOpenAIMessages(messages: readonly InputMessage[], cacheHints: boolean): OpenAIMessage[] {
	const out: OpenAIMessage[] = [];
	for (const msg of messages) {
		if (msg.role === ROLE_ASSISTANT) {
			const text = msg.content.filter(isText).map((p) => p.value).join('');
			const calls = msg.content.filter(isToolCall).map(
				(c): OpenAIToolCall => ({
					id: c.callId,
					type: 'function',
					function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) },
				}),
			);
			if (!text && calls.length === 0) continue;
			out.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
			continue;
		}
		if (msg.role === ROLE_SYSTEM) {
			const text = msg.content.filter(isText).map((p) => p.value).join('');
			if (text) out.push({ role: 'system', content: text });
			continue;
		}
		if (msg.role !== ROLE_USER) continue;
		const parts: OpenAIContentPart[] = [];
		for (const part of msg.content) {
			if (isToolResult(part)) {
				out.push({ role: 'tool', tool_call_id: part.callId, content: toolResultText(part.content) });
			} else if (isText(part)) {
				if (part.value) parts.push({ type: 'text', text: part.value });
			} else if (isData(part) && part.mimeType.startsWith('image/')) {
				const b64 = Buffer.from(part.data).toString('base64');
				parts.push({ type: 'image_url', image_url: { url: `data:${part.mimeType};base64,${b64}` } });
			} else if (isData(part) && part.mimeType === 'cache_control' && cacheHints) {
				const last = parts[parts.length - 1];
				if (last?.type === 'text') last.cache_control = { type: 'ephemeral' };
			}
		}
		if (parts.length) out.push({ role: 'user', content: parts });
	}
	return out;
}

export function toOpenAITools(
	tools: readonly { name: string; description: string; inputSchema?: object }[] | undefined,
): OpenAITool[] | undefined {
	if (!tools?.length) return undefined;
	return tools.map((t) => ({
		type: 'function',
		function: {
			name: t.name,
			description: t.description,
			parameters: t.inputSchema ?? { type: 'object', properties: {} },
		},
	}));
}

/** Rough token estimate: about four characters per token, a flat cost per image. */
export function estimateTokens(input: string | InputMessage): number {
	if (typeof input === 'string') return Math.ceil(input.length / 4);
	let chars = 0;
	let images = 0;
	for (const part of input.content) {
		if (isText(part)) chars += part.value.length;
		else if (isToolCall(part)) chars += JSON.stringify(part.input ?? {}).length + part.name.length;
		else if (isToolResult(part)) chars += toolResultText(part.content).length;
		else if (isData(part) && part.mimeType.startsWith('image/')) images++;
	}
	return Math.ceil(chars / 4) + images * 1_000;
}
