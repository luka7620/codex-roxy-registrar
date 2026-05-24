# codex-openai-reauthorizer

Independent OpenAI/Codex reauthorization tool for sub2api accounts.

It scans or selects one sub2api OpenAI OAuth account, opens the OpenAI OAuth URL in a real browser, logs in with email OTP from the configured Cloudflare mailbox service, exchanges the callback code through sub2api, updates the original account credentials with `PUT /api/v1/admin/accounts/:id`, clears the account error, writes a local token JSON, and appends a local reauth log.

For free accounts, if OpenAI asks to add a phone number, the account is skipped and logged. For plus accounts, the tool falls back to a session access-token export from `https://chatgpt.com/api/auth/session` and updates the original account with a no-refresh-token credential while preserving `plan_type: "plus"`.

## Setup

```powershell
npm install
Copy-Item config.example.json config.json
notepad config.json
```

Required config:

- `sub2apiBaseUrl`
- `sub2apiAdminEmail`
- `sub2apiAdminPassword`
- `mailBaseUrl`
- `mailAdminPassword`

`mailDomain` is optional. Leave it empty when your Cloudflare mailbox admin can query multiple domains; the tool will query mails by full email address through admin endpoints first.

## Usage

Run a specific account:

```powershell
node index.js --account-id 123
```

Run by email:

```powershell
node index.js --email user@example.com
```

Auto-pick the first matching candidate:

```powershell
node index.js --auto
```

List candidates only:

```powershell
node index.js --list-candidates
```

Interactive scan and confirm before starting:

```powershell
node index.js --interactive
```

You can also combine it with filters:

```powershell
node index.js --interactive --group plus
node index.js --interactive --email user@example.com
```

Useful filters:

```powershell
node index.js --auto --group plus --plan plus
node index.js --auto --group-id 1
node index.js --auto --prefer-group plus
node index.js --auto --prefer-group-id 1
```

`--group` and `--group-id` filter candidates strictly. `--prefer-group` and `--prefer-group-id` only change priority: matching accounts are tried first, and other matching candidates remain available.

## Notes

- The original sub2api account name, groups, proxy, concurrency, priority, and extra data are preserved on update.
- The account's own `proxy_id` is reused for generate-auth-url and exchange-code.
- The local token filename defaults to plan-aware mode: `codex-{email}-{plan_type}.json`.
- Set `tokenFilenameMode` to `legacy-free` if you need the old `codex-{email}-free.json` filename.
