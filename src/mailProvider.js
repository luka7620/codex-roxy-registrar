const axios = require('axios');
const { randomInt } = require('node:crypto');

class MailProvider {
  constructor(options) {
    this.baseUrl = String(options.baseUrl || '').replace(/\/+$/, '');
    this.adminPassword = options.adminPassword;
    this.sitePassword = options.sitePassword || '';
    this.domain = options.domain;
    this.timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 45000;
    this.jwt = null;
    this.address = null;
    this.addressId = null;
    this.addressSessionCache = new Map();
    this.sessionLookupTried = new Set();
  }

  _adminHeaders() {
    const headers = {
      'Content-Type': 'application/json',
      'x-admin-auth': this.adminPassword,
    };
    if (this.sitePassword) headers['x-custom-auth'] = this.sitePassword;
    return headers;
  }

  _addressHeaders() {
    const headers = {
      Authorization: `Bearer ${this.jwt}`,
    };
    if (this.sitePassword) headers['x-custom-auth'] = this.sitePassword;
    return headers;
  }

  _normalizeAddress(address) {
    return String(address || '').trim().toLowerCase();
  }

  _extractAddressParts(address) {
    const normalized = String(address || '').trim();
    const at = normalized.lastIndexOf('@');
    if (at <= 0 || at === normalized.length - 1) return null;
    return {
      name: normalized.slice(0, at),
      domain: normalized.slice(at + 1),
      full: normalized,
    };
  }

  _extractMailsFromPayload(payload) {
    if (!payload) return null;
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload.results)) return payload.results;
    if (Array.isArray(payload.mails)) return payload.mails;
    if (payload.data) {
      if (Array.isArray(payload.data)) return payload.data;
      if (Array.isArray(payload.data.results)) return payload.data.results;
      if (Array.isArray(payload.data.mails)) return payload.data.mails;
    }
    return null;
  }

  _extractSessionFromPayload(payload, address) {
    if (!payload || typeof payload !== 'object') return null;
    const jwt = payload.jwt || payload.token || payload.access_token || payload?.data?.jwt || payload?.data?.token;
    if (!jwt) return null;

    return {
      address: payload.address || payload.email || payload?.data?.address || payload?.data?.email || address,
      jwt,
      addressId: payload.address_id || payload.addressId || payload?.data?.address_id || payload?.data?.addressId || null,
    };
  }

  _cacheCurrentSession() {
    const key = this._normalizeAddress(this.address);
    if (!key || !this.jwt) return;
    this.addressSessionCache.set(key, {
      address: this.address,
      jwt: this.jwt,
      addressId: this.addressId || null,
    });
  }

  _loadSessionFromCache(address) {
    const cached = this.addressSessionCache.get(this._normalizeAddress(address));
    if (!cached) return false;
    this.useExistingAddressSession(cached);
    return true;
  }

  _randomName() {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const length = 8 + randomInt(5);
    let name = '';
    for (let index = 0; index < length; index += 1) {
      name += chars[randomInt(chars.length)];
    }
    return name;
  }

  async createAddress(name = null) {
    const emailName = name || this._randomName();
    const response = await axios.post(
      `${this.baseUrl}/admin/new_address`,
      { name: emailName, domain: this.domain, enablePrefix: false },
      { headers: this._adminHeaders(), timeout: this.timeoutMs }
    );

    this.jwt = response.data.jwt;
    this.address = response.data.address;
    this.addressId = response.data.address_id;
    this._cacheCurrentSession();
    return { jwt: this.jwt, address: this.address, addressId: this.addressId };
  }

  useExistingAddressSession(session = {}) {
    if (!session.address || !session.jwt) {
      throw new Error('Mailbox session is incomplete');
    }
    this.address = session.address;
    this.jwt = session.jwt;
    this.addressId = session.addressId || null;
    this._cacheCurrentSession();
  }

  async getMails(limit = 10, offset = 0) {
    const response = await axios.get(`${this.baseUrl}/api/mails`, {
      params: { limit, offset },
      headers: this._addressHeaders(),
      timeout: this.timeoutMs,
    });
    return response.data.results || [];
  }

  async _tryCreateAddressSession(address) {
    const normalized = this._normalizeAddress(address);
    if (!normalized || this.sessionLookupTried.has(normalized)) return false;
    this.sessionLookupTried.add(normalized);

    const parts = this._extractAddressParts(address);
    if (!parts) return false;
    if (this.domain && parts.domain.toLowerCase() !== String(this.domain).toLowerCase()) return false;

    try {
      const created = await this.createAddress(parts.name);
      return this._normalizeAddress(created?.address) === normalized;
    } catch {
      return false;
    }
  }

  async _tryFetchSessionByAdmin(address) {
    const candidates = [
      { method: 'get', url: '/admin/address', params: { address } },
      { method: 'get', url: '/admin/address', params: { email: address } },
      { method: 'post', url: '/admin/address', data: { address } },
      { method: 'post', url: '/admin/get_address', data: { address } },
      { method: 'post', url: '/admin/get_address', data: { email: address } },
      { method: 'post', url: '/admin/get_address_session', data: { address } },
      { method: 'post', url: '/admin/address_session', data: { address } },
    ];

    for (const candidate of candidates) {
      try {
        const response = await axios({
          method: candidate.method,
          url: `${this.baseUrl}${candidate.url}`,
          params: candidate.params,
          data: candidate.data,
          headers: this._adminHeaders(),
          timeout: this.timeoutMs,
        });
        const session = this._extractSessionFromPayload(response.data, address);
        if (session && this._normalizeAddress(session.address) === this._normalizeAddress(address)) {
          this.useExistingAddressSession(session);
          return true;
        }
      } catch {
        // Try next endpoint shape.
      }
    }
    return false;
  }

  async _fetchMailsByAdmin(address, limit, offset) {
    const candidates = [
      { method: 'get', url: '/admin/mails', params: { address, limit, offset } },
      { method: 'get', url: '/admin/mails', params: { email: address, limit, offset } },
      { method: 'post', url: '/admin/mails', data: { address, limit, offset } },
      { method: 'get', url: '/admin/get_mails', params: { address, limit, offset } },
      { method: 'get', url: '/api/mails', params: { address, limit, offset } },
      { method: 'get', url: '/api/mails', params: { email: address, limit, offset } },
    ];

    let lastError = null;
    for (const candidate of candidates) {
      try {
        const response = await axios({
          method: candidate.method,
          url: `${this.baseUrl}${candidate.url}`,
          params: candidate.params,
          data: candidate.data,
          headers: this._adminHeaders(),
          timeout: this.timeoutMs,
        });
        const mails = this._extractMailsFromPayload(response.data);
        if (Array.isArray(mails)) return mails;
        const session = this._extractSessionFromPayload(response.data, address);
        if (session) {
          this.useExistingAddressSession(session);
          return await this.getMails(limit, offset);
        }
      } catch (error) {
        lastError = error;
      }
    }

    if (lastError) throw lastError;
    return [];
  }

  async getMailsByAddress(address, limit = 10, offset = 0) {
    const normalized = this._normalizeAddress(address);
    if (!normalized) throw new Error('email is empty');

    if (this._normalizeAddress(this.address) === normalized && this.jwt) {
      return await this.getMails(limit, offset);
    }
    if (this._loadSessionFromCache(normalized)) {
      return await this.getMails(limit, offset);
    }

    try {
      const mails = await this._fetchMailsByAdmin(normalized, limit, offset);
      if (Array.isArray(mails)) return mails;
    } catch (adminError) {
      // Fall through to session lookup variants. Some mailbox deployments only
      // expose mail listing through an address JWT, not directly by admin query.
    }

    const hasSession = await this._tryFetchSessionByAdmin(normalized) || await this._tryCreateAddressSession(normalized);
    if (hasSession && this._normalizeAddress(this.address) === normalized && this.jwt) {
      return await this.getMails(limit, offset);
    }

    return await this._fetchMailsByAdmin(normalized, limit, offset);
  }
}

module.exports = { MailProvider };
