# Hubris Provider for GitHub Copilot Chat

Use models from Anthropic, OpenAI, Google, DeepSeek, Qwen, Moonshot, Z.ai and other vendors in GitHub Copilot Chat with one [Hubris](https://hubris.pw) account. Hubris is an OpenAI-compatible gateway billed in rubles.

## Setup

1. Install this extension.
2. Click **Hubris** in the status bar, or run **Hubris: Sign In** from the Command Palette (`Ctrl+Shift+P`).
3. Confirm access on hubris.pw in the browser. There is no key to copy: VS Code receives its own token, with a daily spending limit you choose on that page.
4. Pick a Hubris model in the chat model picker.

Prefer an API key? Run **Hubris: Use API Key** and paste a key from [hubris.pw/keys](https://hubris.pw/keys).

## What you get

- **Every Hubris model that can call tools**, which agent mode needs. Hover over a model to see its id and price per million tokens.
- **Your balance in the status bar.** It updates after each answer. Click it to top up, open usage, switch between browser sign-in and an API key, or sign out.
- **A Top up button** when the balance runs out, instead of a bare error.
- **Prompt caching for Anthropic models**, so long agent sessions cost less.
- **Image input** for models that accept images.

To keep the picker short, list the ids you want in the `hubris.models` setting:

```json
"hubris.models": ["anthropic/claude-sonnet-5", "openai/gpt-5.6-luna", "deepseek/deepseek-v4-pro"]
```

The full catalogue with prices is at [hubris.pw/models](https://hubris.pw/models).

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `hubris.models` | `[]` | Model ids to show. Empty shows all models with tool calling. |
| `hubris.showBalance` | `true` | Show the balance in the status bar. |
| `hubris.baseUrl` | `https://api.hubris.pw/v1` | API address. Change it only if support asks you to. |

Tokens and keys are kept in VS Code secret storage. With nothing saved, the extension reads the `HUBRIS_API_KEY` environment variable.

## Notes

- Requires VS Code 1.106 or newer with GitHub Copilot Chat.
- On Copilot Business and Enterprise plans an administrator can turn off models from extensions.
- Requests go from VS Code straight to `api.hubris.pw`. Usage and spending are on your [Hubris dashboard](https://hubris.pw/usage).

## По-русски

Расширение добавляет модели Hubris в чат GitHub Copilot в VS Code. Установите его, нажмите **Hubris** в строке состояния и подтвердите доступ на hubris.pw. Копировать ключ не нужно. Модели появятся в списке моделей чата, а баланс будет виден в строке состояния; по нажатию на него можно пополнить баланс. Войти можно и по ключу API: команда **Hubris: Войти по ключу API**. Поддержка: support@hubris.pw.

## License

MIT
