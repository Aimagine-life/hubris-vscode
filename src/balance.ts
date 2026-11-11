// Balance lookup. An API key reads /v1/key; a browser sign-in has no access to it and asks the
// MCP tool balance_get instead (scope balance:read).

export interface Balance {
	/** Kopecks. */
	kopecks: number;
	/** true when the key cannot see account money and this is what is left of its own limit. */
	keyLimit: boolean;
}

export function parseKeyInfo(body: unknown): Balance | undefined {
	const d = (body as { data?: { balance_kopecks?: number | null; limit_remaining_kopecks?: number | null } })?.data;
	if (typeof d?.balance_kopecks === 'number') return { kopecks: d.balance_kopecks, keyLimit: false };
	if (typeof d?.limit_remaining_kopecks === 'number') return { kopecks: d.limit_remaining_kopecks, keyLimit: true };
	return undefined;
}

/** Reads a JSON-RPC reply that may come as plain JSON or as one SSE message. */
export function parseMcpBalance(raw: string): Balance | undefined {
	const jsonText = raw.trimStart().startsWith('{')
		? raw
		: raw
				.split('\n')
				.filter((l) => l.startsWith('data:'))
				.map((l) => l.slice(5).trim())
				.join('');
	try {
		const msg = JSON.parse(jsonText) as {
			result?: { structuredContent?: { balanceKopecks?: string | number }; isError?: boolean };
		};
		if (msg.result?.isError) return undefined;
		const k = Number(msg.result?.structuredContent?.balanceKopecks);
		return Number.isFinite(k) ? { kopecks: k, keyLimit: false } : undefined;
	} catch {
		return undefined;
	}
}

const rub = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function formatRub(kopecks: number): string {
	return `${rub.format(kopecks / 100)} ₽`;
}

export async function fetchBalance(
	baseUrl: string,
	origin: string,
	token: string,
	kind: 'oauth' | 'key' | 'env',
	userAgent: string,
): Promise<Balance | undefined> {
	const headers = { Authorization: `Bearer ${token}`, 'User-Agent': userAgent };
	if (kind !== 'oauth') {
		const res = await fetch(`${baseUrl}/key`, { headers });
		return res.ok ? parseKeyInfo(await res.json()) : undefined;
	}
	const res = await fetch(`${origin}/mcp`, {
		method: 'POST',
		headers: { ...headers, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'balance_get', arguments: {} } }),
	});
	return res.ok ? parseMcpBalance(await res.text()) : undefined;
}
