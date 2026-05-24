const fs = require('fs');
const path = require('path');

function safeFileSegment(value) {
  return String(value || 'unknown').trim().replace(/[\\/:*?"<>|]/g, '_');
}

function normalizePlanType(planType) {
  return String(planType || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function formatIsoFromEpoch(epochSeconds) {
  const seconds = Number(epochSeconds) || 0;
  if (!seconds) return '';
  return new Date(seconds * 1000).toISOString();
}

function buildTokenFileName(credentials, mode = 'plan') {
  const email = safeFileSegment(credentials.email);
  if (mode === 'legacy-free') return `codex-${email}-free.json`;
  const plan = normalizePlanType(credentials.plan_type || credentials.chatgpt_plan_type);
  if (!plan) return `codex-${email}.json`;
  return `codex-${email}-${plan}.json`;
}

function buildTokenJson(credentials) {
  const now = new Date().toISOString();
  return {
    type: 'codex',
    account_id: credentials.chatgpt_account_id || credentials.account_id || '',
    chatgpt_account_id: credentials.chatgpt_account_id || credentials.account_id || '',
    chatgpt_user_id: credentials.chatgpt_user_id || '',
    email: credentials.email || '',
    plan_type: credentials.plan_type || '',
    id_token: credentials.id_token || '',
    access_token: credentials.access_token || '',
    refresh_token: credentials.refresh_token || '',
    session_token: credentials.session_token || '',
    disabled: false,
    last_refresh: now,
    expired: formatIsoFromEpoch(credentials.expires_at),
    auth_mode: credentials.auth_mode || '',
  };
}

function writeTokenFiles(credentials, config) {
  const filename = buildTokenFileName(credentials, config.tokenFilenameMode);
  const tokenJson = buildTokenJson(credentials);
  const savedPaths = [];

  for (const dir of config.tokenOutputDirs) {
    const outputDir = path.isAbsolute(dir) ? dir : path.join(process.cwd(), dir);
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
    const filePath = path.join(outputDir, filename);
    fs.writeFileSync(filePath, JSON.stringify(tokenJson, null, 2));
    savedPaths.push(filePath);
  }

  return { filename, savedPaths, tokenJson };
}

module.exports = {
  writeTokenFiles,
  buildTokenJson,
};
