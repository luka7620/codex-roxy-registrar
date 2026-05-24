const axios = require('axios');

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function extractList(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.items)) return data.items;
  if (Array.isArray(data?.list)) return data.list;
  if (Array.isArray(data?.accounts)) return data.accounts;
  if (Array.isArray(data?.results)) return data.results;
  if (Array.isArray(data?.data)) return data.data;
  return [];
}

function extractTotal(data) {
  return Number(data?.total || data?.count || data?.pagination?.total || data?.page?.total || 0);
}

function compactObject(input) {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined)
  );
}

function isApiEnvelope(payload) {
  return payload && typeof payload === 'object' && Object.prototype.hasOwnProperty.call(payload, 'code');
}

function normalizeTokenPair(payload) {
  const data = isApiEnvelope(payload) ? payload.data : payload;
  return {
    accessToken: String(data?.access_token || ''),
    refreshToken: String(data?.refresh_token || ''),
    expiresIn: Number(data?.expires_in || 0),
    tokenType: String(data?.token_type || ''),
  };
}

class Sub2ApiClient {
  constructor(options) {
    this.baseUrl = String(options.baseUrl || '').replace(/\/+$/, '');
    this.adminEmail = String(options.adminEmail || '');
    this.adminPassword = String(options.adminPassword || '');
    this.turnstileToken = String(options.turnstileToken || '');
    this.timeoutMs = Number(options.timeoutMs) || 45000;
    this.accessToken = String(options.accessToken || '');
    this.refreshToken = String(options.refreshToken || '');
    this.expiresAt = Number(options.expiresAt || 0);
    this.loginPromise = null;
    if (!this.baseUrl) throw new Error('sub2apiBaseUrl is required');
    if (!this.adminEmail) throw new Error('sub2apiAdminEmail is required');
    if (!this.adminPassword) throw new Error('sub2apiAdminPassword is required');
  }

  buildHeaders(extraHeaders = {}) {
    const headers = {
      'Content-Type': 'application/json',
      ...extraHeaders,
    };
    if (this.accessToken) {
      headers.Authorization = `Bearer ${this.accessToken}`;
    }
    return headers;
  }

  isAccessTokenExpired(bufferMs = 0) {
    if (!this.accessToken) return true;
    if (!this.expiresAt) return false;
    return Date.now() >= this.expiresAt - bufferMs;
  }

  async login() {
    if (this.loginPromise) return this.loginPromise;

    this.loginPromise = (async () => {
      const response = await axios({
        method: 'POST',
        url: `${this.baseUrl}/api/v1/auth/login`,
        data: {
          email: this.adminEmail,
          password: this.adminPassword,
          turnstile_token: this.turnstileToken || undefined,
        },
        timeout: this.timeoutMs,
        headers: {
          'Content-Type': 'application/json',
        },
      });

      const pair = normalizeTokenPair(response.data);
      if (!pair.accessToken) {
        throw new Error('sub2api login did not return access_token');
      }

      if (pair.tokenType && pair.tokenType.toLowerCase() !== 'bearer') {
        throw new Error(`unexpected token_type from sub2api login: ${pair.tokenType}`);
      }

      this.accessToken = pair.accessToken;
      this.refreshToken = pair.refreshToken;
      this.expiresAt = pair.expiresIn > 0 ? Date.now() + pair.expiresIn * 1000 : 0;

      return pair;
    })();

    try {
      return await this.loginPromise;
    } finally {
      this.loginPromise = null;
    }
  }

  async refreshAccessToken() {
    if (!this.refreshToken) {
      return this.login();
    }

    const response = await axios({
      method: 'POST',
      url: `${this.baseUrl}/api/v1/auth/refresh`,
      data: {
        refresh_token: this.refreshToken,
      },
      timeout: this.timeoutMs,
      headers: {
        'Content-Type': 'application/json',
      },
    });

    const pair = normalizeTokenPair(response.data);
    if (!pair.accessToken) {
      return this.login();
    }

    this.accessToken = pair.accessToken;
    this.refreshToken = pair.refreshToken || this.refreshToken;
    this.expiresAt = pair.expiresIn > 0 ? Date.now() + pair.expiresIn * 1000 : 0;
    return pair;
  }

  async request(method, path, options = {}) {
    if (!this.accessToken || this.isAccessTokenExpired(30 * 1000)) {
      try {
        await this.refreshAccessToken();
      } catch {
        await this.login();
      }
    }

    const doRequest = async () => axios({
      method,
      url: `${this.baseUrl}${path}`,
      params: options.params,
      data: options.body,
      timeout: options.timeoutMs || this.timeoutMs,
      headers: this.buildHeaders(options.headers),
    });

    try {
      const response = await doRequest();
      const payload = response.data;
      if (isApiEnvelope(payload)) {
        if (payload.code !== 0) {
          throw new Error(payload.message || `sub2api returned code ${payload.code}`);
        }
        return payload.data;
      }
      return payload;
    } catch (error) {
      const status = error?.response?.status;
      if (status === 401) {
        try {
          await this.refreshAccessToken();
        } catch {
          await this.login();
        }
        const response = await doRequest();
        const payload = response.data;
        if (isApiEnvelope(payload)) {
          if (payload.code !== 0) {
            throw new Error(payload.message || `sub2api returned code ${payload.code}`);
          }
          return payload.data;
        }
        return payload;
      }
      throw error;
    }
  }

  listAccounts(params = {}) {
    return this.request('GET', '/api/v1/admin/accounts', { params });
  }

  async listAllAccounts(baseParams = {}) {
    const pageSize = Number(baseParams.page_size || baseParams.pageSize || 100) || 100;
    const results = [];

    for (let page = 1; page <= 1000; page += 1) {
      const data = await this.listAccounts({ ...baseParams, page, page_size: pageSize });
      const items = extractList(data);
      results.push(...items);

      const total = extractTotal(data);
      if (!items.length) break;
      if (total && results.length >= total) break;
      if (items.length < pageSize) break;
    }

    return results;
  }

  getAccount(id) {
    return this.request('GET', `/api/v1/admin/accounts/${encodeURIComponent(id)}`);
  }

  generateOpenAiAuthUrl({ proxyId, redirectUri }) {
    return this.request('POST', '/api/v1/admin/openai/generate-auth-url', {
      body: compactObject({
        proxy_id: proxyId || undefined,
        redirect_uri: redirectUri,
      }),
    });
  }

  exchangeOpenAiCode({ sessionId, code, state, redirectUri, proxyId }) {
    return this.request('POST', '/api/v1/admin/openai/exchange-code', {
      body: compactObject({
        session_id: sessionId,
        code,
        state,
        redirect_uri: redirectUri,
        proxy_id: proxyId || undefined,
      }),
    });
  }

  updateAccount(accountId, account, nextCredentials, nextExtra = null) {
    const body = compactObject({
      name: account.name,
      notes: account.notes,
      platform: account.platform || 'openai',
      provider: account.provider || '',
      type: account.type || 'oauth',
      credentials: nextCredentials,
      extra: isPlainObject(nextExtra) ? nextExtra : account.extra,
      proxy_id: account.proxy_id,
      concurrency: account.concurrency,
      load_factor: account.load_factor,
      priority: account.priority,
      rate_multiplier: account.rate_multiplier,
      auto_pause_on_expired: account.auto_pause_on_expired,
      group_ids: Array.isArray(account.group_ids) ? account.group_ids : undefined,
      expires_at: account.expires_at,
    });

    return this.request('PUT', `/api/v1/admin/accounts/${encodeURIComponent(accountId)}`, { body });
  }

  clearError(accountId) {
    return this.request('POST', `/api/v1/admin/accounts/${encodeURIComponent(accountId)}/clear-error`, {
      body: {},
    });
  }
}

module.exports = { Sub2ApiClient, extractList };
