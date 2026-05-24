function parseJwtPayload(token) {
  const raw = String(token || '');
  const parts = raw.split('.');
  if (parts.length < 2) return null;
  try {
    const segment = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = segment.padEnd(Math.ceil(segment.length / 4) * 4, '=');
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function toEpochSeconds(value) {
  if (!value) return 0;
  if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value);
  const parsedNumber = Number(value);
  if (Number.isFinite(parsedNumber) && parsedNumber > 0) return Math.floor(parsedNumber);
  const parsedDate = Date.parse(String(value));
  if (Number.isFinite(parsedDate) && parsedDate > 0) return Math.floor(parsedDate / 1000);
  return 0;
}

function getOpenAiAuth(payload) {
  return payload?.['https://api.openai.com/auth'] || {};
}

function buildSyntheticIdToken({ email, accountId, userId, planType, expiresAt }) {
  const now = Math.floor(Date.now() / 1000);
  const exp = Number(expiresAt) || now + 10 * 24 * 60 * 60;
  const auth = { chatgpt_account_id: accountId || '' };
  if (userId) {
    auth.chatgpt_user_id = userId;
    auth.user_id = userId;
  }
  if (planType) {
    auth.chatgpt_plan_type = planType;
  }
  const payload = {
    iat: now,
    exp,
    email,
    'https://api.openai.com/auth': auth,
  };
  return `${base64UrlJson({ alg: 'none', typ: 'JWT', synthetic: true })}.${base64UrlJson(payload)}.`;
}

function mergeOAuthCredentials(oldCredentials = {}, exchangeData = {}) {
  const expiresAt = toEpochSeconds(exchangeData.expires_at)
    || (exchangeData.expires_in ? Math.floor(Date.now() / 1000) + Number(exchangeData.expires_in) : 0)
    || oldCredentials.expires_at;

  return {
    ...oldCredentials,
    access_token: exchangeData.access_token || oldCredentials.access_token || '',
    refresh_token: exchangeData.refresh_token || oldCredentials.refresh_token || '',
    id_token: exchangeData.id_token || oldCredentials.id_token || '',
    client_id: exchangeData.client_id || oldCredentials.client_id || '',
    email: exchangeData.email || oldCredentials.email || '',
    chatgpt_account_id: exchangeData.chatgpt_account_id || oldCredentials.chatgpt_account_id || '',
    chatgpt_user_id: exchangeData.chatgpt_user_id || oldCredentials.chatgpt_user_id || '',
    organization_id: exchangeData.organization_id || oldCredentials.organization_id || '',
    plan_type: exchangeData.plan_type || oldCredentials.plan_type || '',
    expires_at: expiresAt,
    auth_mode: 'oauth',
  };
}

function buildSessionAtCredentials({ account, session, accessToken, forcePlanType = 'plus' }) {
  const oldCredentials = account.credentials || {};
  const payload = parseJwtPayload(accessToken);
  const auth = getOpenAiAuth(payload);
  const sessionObject = session && typeof session === 'object' ? session : {};
  const expiresAt = toEpochSeconds(payload?.exp)
    || toEpochSeconds(sessionObject.expires)
    || Math.floor(Date.now() / 1000) + 10 * 24 * 60 * 60;
  const email = sessionObject?.user?.email || payload?.email || oldCredentials.email || '';
  const accountId = auth.chatgpt_account_id || oldCredentials.chatgpt_account_id || oldCredentials.account_id || '';
  const userId = auth.chatgpt_user_id || auth.user_id || oldCredentials.chatgpt_user_id || '';
  const planType = forcePlanType || auth.chatgpt_plan_type || oldCredentials.plan_type || 'plus';
  const idToken = oldCredentials.id_token || buildSyntheticIdToken({
    email,
    accountId,
    userId,
    planType,
    expiresAt,
  });

  return {
    ...oldCredentials,
    access_token: accessToken,
    refresh_token: '',
    id_token: idToken,
    email,
    chatgpt_account_id: accountId,
    chatgpt_user_id: userId,
    organization_id: oldCredentials.organization_id || '',
    client_id: oldCredentials.client_id || '',
    plan_type: planType,
    expires_at: expiresAt,
    session_token: sessionObject.sessionToken || oldCredentials.session_token || '',
    auth_mode: 'session_at',
  };
}

function buildUpdatedExtra(oldExtra = {}, exchangeData = {}, authMode = '') {
  return {
    ...(oldExtra && typeof oldExtra === 'object' ? oldExtra : {}),
    ...(exchangeData.privacy_mode ? { privacy_mode: exchangeData.privacy_mode } : {}),
    ...(authMode ? { reauth_mode: authMode } : {}),
    reauthorized_at: new Date().toISOString(),
  };
}

module.exports = {
  parseJwtPayload,
  toEpochSeconds,
  mergeOAuthCredentials,
  buildSessionAtCredentials,
  buildUpdatedExtra,
};
