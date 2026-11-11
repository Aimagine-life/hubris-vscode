// Reads an OpenAI-compatible SSE stream and turns it into text and finished tool calls.
// Tool call arguments arrive in fragments keyed by index; a call is emitted once the stream
// says the turn is over, so the receiver always gets complete JSON input.

export type StreamEvent =
	| { type: 'text'; text: string }
	| { type: 'tool_call'; id: string; name: string; input: object };

interface PendingCall {
	id: string;
	name: string;
	args: string;
}

interface ChunkDelta {
	content?: string | null;
	tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[];
}

interface Chunk {
	choices?: { delta?: ChunkDelta; finish_reason?: string | null }[];
	error?: { message?: string };
}

export class StreamError extends Error {}

function parseArgs(raw: string): object {
	if (!raw.trim()) return {};
	try {
		const v: unknown = JSON.parse(raw);
		return typeof v === 'object' && v !== null && !Array.isArray(v) ? v : { value: v };
	} catch {
		throw new StreamError(`The model returned tool arguments that are not valid JSON: ${raw.slice(0, 200)}`);
	}
}

export class ChatStreamParser {
	private buffer = '';
	private readonly calls = new Map<number, PendingCall>();

	/** Feeds raw bytes decoded as text; returns the events completed by this piece. */
	push(text: string): StreamEvent[] {
		this.buffer += text;
		const events: StreamEvent[] = [];
		let nl: number;
		while ((nl = this.buffer.indexOf('\n')) >= 0) {
			const line = this.buffer.slice(0, nl).replace(/\r$/, '');
			this.buffer = this.buffer.slice(nl + 1);
			this.handleLine(line, events);
		}
		return events;
	}

	/** Ends the stream: emits tool calls that were still collecting arguments. */
	end(): StreamEvent[] {
		const events: StreamEvent[] = [];
		if (this.buffer) {
			this.handleLine(this.buffer, events);
			this.buffer = '';
		}
		this.flushCalls(events);
		return events;
	}

	private handleLine(line: string, events: StreamEvent[]): void {
		if (!line.startsWith('data:')) return;
		const data = line.slice(5).trim();
		if (!data || data === '[DONE]') {
			if (data === '[DONE]') this.flushCalls(events);
			return;
		}
		let chunk: Chunk;
		try {
			chunk = JSON.parse(data) as Chunk;
		} catch {
			return; // keep-alive or a line this client does not understand
		}
		if (chunk.error) throw new StreamError(chunk.error.message ?? 'The model stopped with an error.');
		for (const choice of chunk.choices ?? []) {
			const delta = choice.delta;
			if (delta?.content) events.push({ type: 'text', text: delta.content });
			for (const tc of delta?.tool_calls ?? []) {
				const index = tc.index ?? 0;
				const call = this.calls.get(index) ?? { id: '', name: '', args: '' };
				if (tc.id) call.id = tc.id;
				if (tc.function?.name) call.name = tc.function.name;
				if (tc.function?.arguments) call.args += tc.function.arguments;
				this.calls.set(index, call);
			}
			if (choice.finish_reason) this.flushCalls(events);
		}
	}

	private flushCalls(events: StreamEvent[]): void {
		const ordered = [...this.calls.entries()].sort((a, b) => a[0] - b[0]);
		for (const [index, call] of ordered) {
			if (!call.name) continue;
			events.push({
				type: 'tool_call',
				id: call.id || `call_${index}_${Date.now()}`,
				name: call.name,
				input: parseArgs(call.args),
			});
		}
		this.calls.clear();
	}
}
