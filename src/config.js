const fs = require('fs');
const path = require('path');
require('dotenv').config();

function readJson(filePath) {
  if (!fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Failed to parse config file ${filePath}: ${error.message}`);
  }
}

function envOrConfig(envName, config, key, fallback = '') {
  const envValue = process.env[envName];
  if (envValue !== undefined && envValue !== '') return envValue;
  return config[key] !== undefined ? config[key] : fallback;
}

function toInt(value, fallback = 0) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toArray(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (typeof value === 'string' && value.trim()) {
    return value.split(',').map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function loadConfig() {
  const configPath = path.join(process.cwd(), 'config.json');
  const raw = readJson(configPath);

  const tokenOutputDirs = toArray(envOrConfig('TOKEN_OUTPUT_DIRS', raw, 'tokenOutputDirs', []));
  const candidateErrorKeywords = toArray(envOrConfig('CANDIDATE_ERROR_KEYWORDS', raw, 'candidateErrorKeywords', []));
  const preferredGroupNames = toArray(envOrConfig('PREFERRED_GROUP_NAMES', raw, 'preferredGroupNames', []));
  const preferredGroupIds = toArray(envOrConfig('PREFERRED_GROUP_IDS', raw, 'preferredGroupIds', []));

  return {
    sub2apiBaseUrl: String(envOrConfig('SUB2API_BASE_URL', raw, 'sub2apiBaseUrl', '')).replace(/\/+$/, ''),
    sub2apiAdminEmail: String(envOrConfig('SUB2API_ADMIN_EMAIL', raw, 'sub2apiAdminEmail', '')),
    sub2apiAdminPassword: String(envOrConfig('SUB2API_ADMIN_PASSWORD', raw, 'sub2apiAdminPassword', '')),
    sub2apiTurnstileToken: String(envOrConfig('SUB2API_TURNSTILE_TOKEN', raw, 'sub2apiTurnstileToken', '')),

    mailBaseUrl: String(envOrConfig('MAIL_BASE_URL', raw, 'mailBaseUrl', '')).replace(/\/+$/, ''),
    mailAdminPassword: String(envOrConfig('MAIL_ADMIN_PASSWORD', raw, 'mailAdminPassword', '')),
    mailSitePassword: String(envOrConfig('MAIL_SITE_PASSWORD', raw, 'mailSitePassword', '')),
    mailDomain: String(envOrConfig('MAIL_DOMAIN', raw, 'mailDomain', '')),
    mailTimeoutMs: toInt(envOrConfig('MAIL_TIMEOUT_MS', raw, 'mailTimeoutMs', 45000), 45000),

    oauthRedirectUri: String(envOrConfig('OAUTH_REDIRECT_URI', raw, 'oauthRedirectUri', 'http://localhost:1455/auth/callback')),
    tokenOutputDirs: tokenOutputDirs.length ? tokenOutputDirs : ['tokens'],
    tokenFilenameMode: String(envOrConfig('TOKEN_FILENAME_MODE', raw, 'tokenFilenameMode', 'plan')),
    reauthLogFile: String(envOrConfig('REAUTH_LOG_FILE', raw, 'reauthLogFile', 'data/reauth-log.json')),

    browserWindowWidth: toInt(envOrConfig('BROWSER_WINDOW_WIDTH', raw, 'browserWindowWidth', 960), 960),
    browserWindowHeight: toInt(envOrConfig('BROWSER_WINDOW_HEIGHT', raw, 'browserWindowHeight', 540), 540),
    browserWindowStartX: toInt(envOrConfig('BROWSER_WINDOW_START_X', raw, 'browserWindowStartX', 0), 0),
    browserWindowStartY: toInt(envOrConfig('BROWSER_WINDOW_START_Y', raw, 'browserWindowStartY', 0), 0),
    useChrome: raw.useChrome !== false,
    chromePath: String(envOrConfig('CHROME_PATH', raw, 'chromePath', '')),
    useEdge: raw.useEdge === true,
    edgePath: String(envOrConfig('EDGE_PATH', raw, 'edgePath', '')),

    candidateErrorKeywords: candidateErrorKeywords.length ? candidateErrorKeywords : [
      'invalid_grant',
      'Token refresh failed',
      'Authentication failed (401)',
      'token_revoked',
      'token_invalidated',
      'unauthenticated',
    ],
    preferredGroupNames,
    preferredGroupIds,
  };
}

module.exports = { loadConfig };
