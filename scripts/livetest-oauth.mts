// Live: browser sign-in against the real Hubris as the test bot, then models, chat, balance, refresh.
import { readFileSync } from 'node:fs';
import { fetchBalance } from '../src/balance.ts';
import { refreshTokens, signIn } from '../src/oauth.ts';

const origin = 'https://api.hubris.pw';
const jar = readFileSync(process.argv[2], 'utf8');
const session = jar.split('\n').map((l) => l.split('\t')).find((f) => f[5] === 'gw_session')?.[6]?.trim();
if (!session) throw new Error('no session cookie');

async function browser(url: string) {
  const get = await fetch(url, { headers: { Cookie: `gw_session=${session}` }, redirect: 'manual' });
  const html = await get.text();
  if (get.status !== 200) throw new Error(`authorize GET ${get.status}: ${html.slice(0, 200)}`);
  const csrfCookie = (get.headers.get('set-cookie') ?? '').match(/[^=;\s]*csrf[^=]*=([^;]+)/i);
  const csrfName = (get.headers.get('set-cookie') ?? '').match(/([^=;\s]*csrf[^=]*)=/i)?.[1];
  const token = html.match(/name="csrf_token" value="([^"]+)"/)?.[1];
  const scopes = [...html.matchAll(/name="scope" value="([^"]+)"/g)].map((m) => m[1]);
  const limit = html.match(/name="daily_limit_rub" value="([^"]+)"/)?.[1] ?? '500';
  console.log('consent page: scopes', scopes, 'limit', limit, 'client shown:', /VS Code/.test(html));
  const form = new URLSearchParams({ csrf_token: token!, action: 'allow', offline: '1', daily_limit_rub: limit });
  for (const s of scopes) form.append('scope', s);
  const post = await fetch(url, {
    method: 'POST',
    headers: { Cookie: `gw_session=${session}; ${csrfName}=${csrfCookie![1]}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
    redirect: 'manual',
  });
  const loc = post.headers.get('location');
  if (!loc) throw new Error(`consent POST ${post.status}: ${(await post.text()).slice(0, 200)}`);
  const back = await fetch(loc);
  console.log('loopback page status', back.status);
}

const t = await signIn({ origin, clientName: 'VS Code (live test)', open: browser, signal: new AbortController().signal, pages: { success: 'ok', failure: (r) => r } });
console.log('tokens:', t.accessToken.slice(0, 7), 'refresh:', Boolean(t.refreshToken), 'expires in min:', Math.round((t.expiresAt - Date.now()) / 60000));
const h = { Authorization: `Bearer ${t.accessToken}` };
const models = await fetch(`${origin}/v1/models`, { headers: h }).then((r) => r.json() as Promise<{ data: unknown[] }>);
console.log('models with oauth token:', models.data.length);
const chat = await fetch(`${origin}/v1/chat/completions`, { method: 'POST', headers: { ...h, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'google/gemini-2.5-flash', messages: [{ role: 'user', content: 'Reply with one word: PONG' }] }) });
console.log('chat:', chat.status, ((await chat.json()) as any).choices?.[0]?.message?.content?.trim());
console.log('balance via mcp:', await fetchBalance(`${origin}/v1`, origin, t.accessToken, 'oauth', 'live-test'));
const n = await refreshTokens(origin, t);
console.log('refreshed:', n.accessToken !== t.accessToken, 'new refresh:', n.refreshToken !== t.refreshToken);
for (const tok of [n.refreshToken!, n.accessToken]) {
  const r = await fetch(`${origin}/oauth/revoke`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: tok, client_id: n.clientId }).toString() });
  console.log('revoke', r.status);
}
const after = await fetch(`${origin}/v1/models`, { headers: { Authorization: `Bearer ${n.accessToken}` } });
console.log('after revoke access token status:', after.status);
