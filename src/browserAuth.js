const fs = require('fs');
const os = require('os');
const path = require('path');
const { connect } = require('puppeteer-real-browser');
const { extractVerificationCodeFromMailRaw } = require('./emailCode');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const EMAIL_LOGIN_TEXTS = [
  'Continue with email',
  'Continue with email address',
  'Log in with email',
  'email',
  '鐢靛瓙閭欢鍦板潃鐧诲綍',
  '閭鐧诲綍',
  '缁х画浣跨敤鐢靛瓙閭欢鍦板潃鐧诲綍',
];

const OTP_TEXTS = [
  'Use a one-time code',
  'one-time code',
  'one time code',
  'email code',
  'send code',
  'magic code',
  'try another way',
  'verification code',
  '浣跨敤涓€娆℃€ч獙璇佺爜鐧诲綍',
  '涓€娆℃€ч獙璇佺爜鐧诲綍',
  '涓€娆℃€ч獙璇佺爜',
];

function textMatchesAny(value, candidates) {
  const text = String(value || '');
  const lower = text.toLowerCase();
  return candidates.some((candidate) => {
    const expected = String(candidate || '');
    return expected && (text.includes(expected) || lower.includes(expected.toLowerCase()));
  });
}

const CODE_PAGE_TEXT_RE = /(email[-_\s]?verification|verify[-_\s]?email|verification code|one[-\s]?time code|one[-\s]?time|email code|security code|passcode|otp|\u9a8c\u8bc1\u7801|\u9a8c\u8b49\u78bc|\u4e00\u6b21\u6027)/i;
const CODE_FIELD_TEXT_RE = /(verification|verify|code|otp|passcode|security|one[-\s]?time|\u9a8c\u8bc1\u7801|\u9a8c\u8b49\u78bc|\u4e00\u6b21\u6027)/i;
const NON_CODE_FIELD_TEXT_RE = /(phone|mobile|email|user(name)?|identifier|login|password)/i;

function getInputSearchText(input) {
  return [
    input?.name,
    input?.placeholder,
    input?.id,
    input?.autocomplete,
    input?.ariaLabel,
    input?.inputMode,
    input?.type,
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function isLikelyVerificationInput(input) {
  if (!input || !input.visible) return false;

  const type = String(input.type || '').toLowerCase();
  if (type === 'hidden' || type === 'password') return false;

  const searchText = getInputSearchText(input);
  const hasCodeHint = CODE_FIELD_TEXT_RE.test(searchText) || String(input.autocomplete || '').toLowerCase() === 'one-time-code';
  const numericType = type === 'tel' || type === 'number' || String(input.inputMode || '').toLowerCase() === 'numeric';
  const shortLength = Number(input.maxLength) > 0 && Number(input.maxLength) <= 8;
  const blockedByIdentityHint = NON_CODE_FIELD_TEXT_RE.test(searchText);

  if (hasCodeHint) return true;
  if (numericType && shortLength && !blockedByIdentityHint) return true;
  if (numericType && /code|verify|otp|passcode|security|\u9a8c\u8bc1\u7801|\u9a8c\u8b49\u78bc|\u4e00\u6b21\u6027/i.test(searchText) && !blockedByIdentityHint) return true;
  return false;
}

function isCodePage(pageInfo) {
  const url = String(pageInfo?.url || '').toLowerCase();
  const pageText = `${pageInfo?.url || ''}\n${pageInfo?.text || ''}`.toLowerCase();
  const hasCodeRoute = /email[-_]?verification|verify[-_]?email|verification|one[-\s]?time|otp/.test(url);
  const hasCodeCopy = CODE_PAGE_TEXT_RE.test(pageText);
  const inputs = Array.isArray(pageInfo?.inputs) ? pageInfo.inputs : [];
  const hasLikelyField = inputs.some((input) => isLikelyVerificationInput(input));
  const hasVisibleInput = inputs.some((input) => Boolean(input?.visible));

  return (hasCodeRoute || hasCodeCopy) && (hasLikelyField || hasVisibleInput);
}

function isConsentPage(pageInfo) {
  const url = String(pageInfo?.url || '').toLowerCase();
  return /sign-in-with-chatgpt\/codex\/consent/.test(url) || /\/consent(?:[/?#]|$)/.test(url);
}

function normalizeMailsFromPayload(payload) {
  if (!payload) return null;
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.results)) return payload.results;
  if (Array.isArray(payload.mails)) return payload.mails;
  if (Array.isArray(payload.items)) return payload.items;
  if (Array.isArray(payload.list)) return payload.list;
  if (Array.isArray(payload.records)) return payload.records;
  if (payload.data) {
    if (Array.isArray(payload.data)) return payload.data;
    if (Array.isArray(payload.data.results)) return payload.data.results;
    if (Array.isArray(payload.data.mails)) return payload.data.mails;
    if (Array.isArray(payload.data.items)) return payload.data.items;
    if (Array.isArray(payload.data.list)) return payload.data.list;
    if (Array.isArray(payload.data.records)) return payload.data.records;
  }
  return null;
}

class AddPhoneRequiredError extends Error {
  constructor(message = 'OpenAI 要求进行手机号验证') {
    super(message);
    this.name = 'AddPhoneRequiredError';
    this.code = 'ADD_PHONE_REQUIRED';
  }
}

class AccountDeactivatedError extends Error {
  constructor(message = 'OpenAI 账号已删除或停用') {
    super(message);
    this.name = 'AccountDeactivatedError';
    this.code = 'ACCOUNT_DEACTIVATED';
  }
}

class BrowserAuth {
  constructor(config) {
    this.config = config;
    this.browser = null;
    this.page = null;
    this.mailboxPage = null;
    this.mailboxBaseUrl = '';
    this.screenshotDir = path.join(os.tmpdir(), 'codex-openai-reauthorizer');
  }

  getBrowserCandidatePaths() {
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    const chromeCandidates = [
      path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ];
    const edgeCandidates = [
      path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ];
    return this.config.useEdge ? [...edgeCandidates, ...chromeCandidates] : [...chromeCandidates, ...edgeCandidates];
  }

  detectExecutablePath() {
    if (process.platform !== 'win32') return '';
    for (const candidate of this.getBrowserCandidatePaths()) {
      if (candidate && fs.existsSync(candidate)) return candidate;
    }
    return '';
  }

  resolveExecutablePath(candidatePath) {
    const candidate = String(candidatePath || '').trim();
    if (!candidate) return this.detectExecutablePath();
    const looksLikeFsPath = candidate.includes('/') || candidate.includes('\\') || path.isAbsolute(candidate);
    if (looksLikeFsPath && !fs.existsSync(candidate)) {
      console.warn(`[浏览器] 配置的浏览器路径不存在：${candidate}`);
      return this.detectExecutablePath();
    }
    return candidate;
  }

  async launch() {
    const args = [
      '--no-sandbox',
      '--disable-gpu',
      `--window-size=${this.config.browserWindowWidth},${this.config.browserWindowHeight}`,
      `--window-position=${this.config.browserWindowStartX},${this.config.browserWindowStartY}`,
    ];
    const connectOptions = {
      headless: false,
      turnstile: true,
      args,
    };

    const preferred = this.config.useEdge ? this.config.edgePath : this.config.chromePath;
    const executablePath = this.resolveExecutablePath(preferred);
    if (executablePath) {
      connectOptions.customConfig = { chromePath: executablePath };
      process.env.CHROME_PATH = executablePath;
      console.log(`[浏览器] 使用可执行文件：${executablePath}`);
    }

    const { browser, page } = await connect(connectOptions);
    this.browser = browser;
    const pages = await browser.pages?.();
    this.page = pages && pages.length > 0 ? await browser.newPage() : page;
    await this.page.bringToFront().catch(() => {});
    await this.page.setViewport({
      width: this.config.browserWindowWidth,
      height: this.config.browserWindowHeight,
    });
  }

  async close() {
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
      this.page = null;
      this.mailboxPage = null;
      this.mailboxBaseUrl = '';
    }
  }

  resolveMailboxBaseUrl(mailProvider) {
    return String(mailProvider?.baseUrl || this.config.mailBaseUrl || '').replace(/\/+$/, '');
  }

  async keepMainPageVisible() {
    if (this.page && !this.page.isClosed?.()) {
      await this.page.bringToFront().catch(() => {});
    }
  }

  async ensureMailboxPage(mailProvider) {
    if (!this.browser) throw new Error('浏览器尚未启动');

    const baseUrl = this.resolveMailboxBaseUrl(mailProvider);
    if (!baseUrl) throw new Error('mailBaseUrl 为空');

    const needsNewPage = !this.mailboxPage || this.mailboxPage.isClosed?.() || this.mailboxBaseUrl !== baseUrl;
    if (needsNewPage) {
      this.mailboxPage = await this.browser.newPage();
      this.mailboxBaseUrl = baseUrl;
      await this.mailboxPage.setViewport({
        width: this.config.browserWindowWidth,
        height: this.config.browserWindowHeight,
      }).catch(() => {});
      console.log(`[邮箱][浏览器] 打开邮箱辅助页：${baseUrl}`);
      await this.mailboxPage.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    }

    await this.keepMainPageVisible();
    return this.mailboxPage;
  }

  async fetchMailsByBrowserPage(mailProvider, email, limit = 20, offset = 0) {
    const mailboxPage = await this.ensureMailboxPage(mailProvider);
    const adminPassword = String(mailProvider?.adminPassword || this.config.mailAdminPassword || '');
    const sitePassword = String(mailProvider?.sitePassword || this.config.mailSitePassword || '');
    const timeoutMs = Number(mailProvider?.timeoutMs || this.config.mailTimeoutMs || 45000);

    const result = await mailboxPage.evaluate(async (params) => {
      const headers = { 'Content-Type': 'application/json' };
      if (params.adminPassword) headers['x-admin-auth'] = params.adminPassword;
      if (params.sitePassword) headers['x-custom-auth'] = params.sitePassword;

      const withQuery = (url, query) => {
        const search = new URLSearchParams();
        Object.entries(query || {}).forEach(([key, value]) => {
          if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
        });
        const queryString = search.toString();
        if (!queryString) return url;
        return `${url}${url.includes('?') ? '&' : '?'}${queryString}`;
      };

      const fetchJson = async (candidate) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), params.timeoutMs);
        try {
          const requestUrl = candidate.params ? withQuery(candidate.url, candidate.params) : candidate.url;
          const init = {
            method: candidate.method,
            headers,
            credentials: 'include',
            signal: controller.signal,
          };
          if (candidate.data) init.body = JSON.stringify(candidate.data);

          const response = await fetch(requestUrl, init);
          const text = await response.text();
          let data = null;
          try {
            data = text ? JSON.parse(text) : null;
          } catch {
            data = { rawText: text.slice(0, 500) };
          }

          return {
            ok: response.ok,
            status: response.status,
            method: candidate.method,
            url: requestUrl,
            data,
            textPreview: text.slice(0, 200),
          };
        } catch (error) {
          return {
            ok: false,
            method: candidate.method,
            url: candidate.url,
            error: error?.message || String(error),
          };
        } finally {
          clearTimeout(timer);
        }
      };

      const candidates = [
        { method: 'GET', url: '/admin/mails', params: { address: params.email, limit: params.limit, offset: params.offset } },
        { method: 'GET', url: '/admin/mails', params: { email: params.email, limit: params.limit, offset: params.offset } },
        { method: 'POST', url: '/admin/mails', data: { address: params.email, limit: params.limit, offset: params.offset } },
        { method: 'GET', url: '/admin/get_mails', params: { address: params.email, limit: params.limit, offset: params.offset } },
        { method: 'GET', url: '/api/mails', params: { address: params.email, limit: params.limit, offset: params.offset } },
        { method: 'GET', url: '/api/mails', params: { email: params.email, limit: params.limit, offset: params.offset } },
      ];

      const attempts = [];
      for (const candidate of candidates) {
        const response = await fetchJson(candidate);
        attempts.push({
          ok: response.ok,
          status: response.status,
          method: response.method,
          url: response.url,
          error: response.error || '',
          textPreview: response.ok ? '' : response.textPreview,
        });
        if (response.ok) {
          return { ok: true, payload: response.data, attempts };
        }
      }

      return { ok: false, attempts };
    }, {
      email,
      limit,
      offset,
      adminPassword,
      sitePassword,
      timeoutMs: Math.min(Math.max(timeoutMs, 5000), 60000),
    });

    await this.keepMainPageVisible();

    if (!result?.ok) {
      const lastAttempt = Array.isArray(result?.attempts) ? result.attempts[result.attempts.length - 1] : null;
      throw new Error(`浏览器邮箱查询失败${lastAttempt?.error ? `：${lastAttempt.error}` : ''}`);
    }

    const mails = normalizeMailsFromPayload(result.payload);
    if (!Array.isArray(mails)) {
      throw new Error('浏览器邮箱响应中没有邮件列表');
    }
    return mails;
  }

  async pollEmailCodeByBrowserPage(mailProvider, email, options = {}) {
    const maxAttempts = Number(options.maxAttempts) || 30;
    const intervalMs = Number(options.intervalMs) || 5000;
    const limit = Number(options.limit) > 0 ? Number(options.limit) : 20;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      console.log(`[邮箱][浏览器] 正在轮询 ${email} 的验证码 (${attempt}/${maxAttempts})`);
      try {
        const mails = await this.fetchMailsByBrowserPage(mailProvider, email, limit, 0);
        if (Array.isArray(mails) && mails.length > 0) {
          for (const mail of mails) {
            const code = extractVerificationCodeFromMailRaw(mail);
            if (code) {
              console.log(`[邮箱][浏览器] 已获取 ${email} 的验证码`);
              await this.keepMainPageVisible();
              return code;
            }
          }
          const firstMail = mails[0];
          const subject = String(firstMail?.subject || firstMail?.title || '').trim();
          console.log(`[邮箱][浏览器] 已收到 ${email} 的邮件，但还没匹配到验证码${subject ? `（主题="${subject.slice(0, 80)}"）` : ''}`);
        }
      } catch (error) {
        console.warn(`[邮箱][浏览器] 轮询失败：${error.message}`);
      }

      await this.keepMainPageVisible();
      await sleep(intervalMs);
    }

    throw new Error(`${email} 邮箱验证码超时`);
  }

  async waitForCloudflare(timeoutMs = 60000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const title = await this.page.title();
        const text = await this.page.evaluate(() => (document.body?.innerText || '').slice(0, 400)).catch(() => '');
        if (!/checking|moment|cloudflare|verify you are human/i.test(`${title}\n${text}`)) {
          return;
        }
      } catch {
        // Navigation can destroy the context.
      }
      await sleep(3000);
    }
    throw new Error('Cloudflare 等待超时');
  }

  async getPageInfo() {
    return await this.page.evaluate(() => ({
      url: location.href,
      text: (document.body?.innerText || '').substring(0, 1000),
      buttons: Array.from(document.querySelectorAll('button, a, [role="button"]'))
        .map((node) => `${node.innerText || ''} ${node.textContent || ''} ${node.getAttribute('aria-label') || ''}`.trim())
        .filter(Boolean),
      inputs: Array.from(document.querySelectorAll('input:not([type="hidden"])')).map((input) => ({
        type: input.type,
        name: input.name,
        placeholder: input.placeholder,
        id: input.id,
        autocomplete: input.autocomplete || '',
        inputMode: input.inputMode || '',
        maxLength: Number(input.maxLength) || 0,
        ariaLabel: input.getAttribute('aria-label') || '',
        visible: !!(input.offsetWidth || input.offsetHeight || input.getClientRects().length),
      })),
    }));
  }

  async clickByText(candidates, timeoutMs = 10000) {
    const items = Array.isArray(candidates) ? candidates : [candidates];
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const clicked = await this.page.evaluate((texts) => {
        for (const node of document.querySelectorAll('button, a, [role="button"]')) {
          const nodeText = `${node.innerText || ''} ${node.textContent || ''} ${node.getAttribute('aria-label') || ''}`.trim();
          const lower = nodeText.toLowerCase();
          const matched = texts.some((item) => {
            const expected = String(item || '');
            return expected && (nodeText.includes(expected) || lower.includes(expected.toLowerCase()));
          });
          if (matched) {
            ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach((type) => {
              node.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
            });
            return true;
          }
        }
        return false;
      }, items);
      if (clicked) return true;
      await sleep(1000);
    }
    return false;
  }

  async clickByXPath(xpath) {
    if (!xpath) return false;
    return await this.page.evaluate((expression) => {
      const result = document.evaluate(
        expression,
        document,
        null,
        XPathResult.FIRST_ORDERED_NODE_TYPE,
        null,
      );
      const node = result?.singleNodeValue;
      if (!node) return false;
      if (typeof node.scrollIntoView === 'function') {
        node.scrollIntoView({ block: 'center', inline: 'center' });
      }
      ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach((type) => {
        node.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      });
      return true;
    }, xpath).catch(() => false);
  }

  async fillInput(selectors, value) {
    let input = null;
    for (const selector of selectors) {
      input = await this.page.$(selector);
      if (input) break;
    }
    if (!input) return false;

    await input.click({ clickCount: 3 }).catch(() => {});
    await this.page.keyboard.press('Backspace').catch(() => {});
    await input.evaluate((node, nextValue) => {
      const proto = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
      const setValue = descriptor && typeof descriptor.set === 'function'
        ? descriptor.set.bind(node)
        : (v) => { node.value = v; };
      node.focus();
      setValue('');
      node.dispatchEvent(new Event('input', { bubbles: true }));
      setValue(String(nextValue || ''));
      node.dispatchEvent(new Event('input', { bubbles: true }));
      node.dispatchEvent(new Event('change', { bubbles: true }));
    }, value);
    return true;
  }

  async clickSubmitButton() {
    await this.page.evaluate(() => {
      const preferredTexts = [
        'Continue',
        'Next',
        'Verify',
        'Submit',
        'Allow',
        '\u7ee7\u7eed',
        '\u4e0b\u4e00\u6b65',
        '\u9a8c\u8bc1',
        '\u63d0\u4ea4',
        '\u5141\u8bb8',
        '\u6388\u6743',
        '\u540c\u610f',
      ];
      for (const button of document.querySelectorAll('button[type="submit"], button')) {
        const text = (button.innerText || '').trim();
        if (button.disabled) continue;
        if (!preferredTexts.some((item) => text === item || text.includes(item))) continue;
        ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach((type) => {
          button.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
        });
        return;
      }
    });
    await sleep(2500);
  }

  async enterVerificationCode(code) {
    const digits = String(code || '').trim();
    const handles = await this.page.$$('input:not([type="hidden"]):not([type="password"])');
    const candidates = [];

    for (const handle of handles) {
      try {
        const info = await handle.evaluate((node) => ({
          type: node.type,
          name: node.name,
          placeholder: node.placeholder,
          id: node.id,
          autocomplete: node.autocomplete || '',
          inputMode: node.inputMode || '',
          maxLength: Number(node.maxLength) || 0,
          ariaLabel: node.getAttribute('aria-label') || '',
          visible: !!(node.offsetWidth || node.offsetHeight || node.getClientRects().length),
        }));
        if (info.visible) candidates.push({ handle, info });
      } catch {
        // Skip detached inputs.
      }
    }

    const searchTextForInput = (input) => [
      input?.name,
      input?.placeholder,
      input?.id,
      input?.autocomplete,
      input?.ariaLabel,
      input?.inputMode,
      input?.type,
    ].map((value) => String(value || '').trim()).filter(Boolean).join(' ').toLowerCase();

    const isVerificationInput = (input) => {
      const type = String(input?.type || '').toLowerCase();
      if (!input?.visible || type === 'hidden' || type === 'password') return false;
      const searchText = searchTextForInput(input);
      const hasCodeHint = /(verification|verify|code|otp|passcode|security|one[-\s]?time|\u9a8c\u8bc1\u7801|\u9a8c\u8b49\u78bc|\u4e00\u6b21\u6027)/i.test(searchText)
        || String(input.autocomplete || '').toLowerCase() === 'one-time-code';
      const numericType = type === 'tel' || type === 'number' || String(input.inputMode || '').toLowerCase() === 'numeric';
      const shortLength = Number(input.maxLength) > 0 && Number(input.maxLength) <= 8;
      const blockedByIdentityHint = /(phone|mobile|email|user(name)?|identifier|login|password)/i.test(searchText);
      if (hasCodeHint) return true;
      if (numericType && shortLength && !blockedByIdentityHint) return true;
      return false;
    };

    const splitInputs = candidates.filter(({ info }) => (
      isVerificationInput(info)
      && (Number(info.maxLength) === 1 || String(info.inputMode || '').toLowerCase() === 'numeric')
    ));

    if (splitInputs.length >= digits.length) {
      for (let index = 0; index < digits.length; index += 1) {
        const target = splitInputs[index].handle;
        await target.click({ clickCount: 1 }).catch(() => {});
        await target.evaluate((node, nextValue) => {
          const proto = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
          const setValue = descriptor && typeof descriptor.set === 'function'
            ? descriptor.set.bind(node)
            : (v) => { node.value = v; };
          node.focus();
          setValue(String(nextValue || ''));
          node.dispatchEvent(new Event('input', { bubbles: true }));
          node.dispatchEvent(new Event('change', { bubbles: true }));
        }, digits[index]);
      }
    } else {
      const ranked = candidates
        .map(({ handle, info }) => {
          const searchText = searchTextForInput(info);
          let score = 0;
          if (String(info.autocomplete || '').toLowerCase() === 'one-time-code') score += 100;
          if (/(verification|verify|code|otp|passcode|security|one[-\s]?time|\u9a8c\u8bc1\u7801|\u9a8c\u8b49\u78bc|\u4e00\u6b21\u6027)/i.test(searchText)) score += 80;
          if (info.type === 'tel' || info.type === 'number') score += 30;
          if (String(info.inputMode || '').toLowerCase() === 'numeric') score += 20;
          if (Number(info.maxLength) > 0 && Number(info.maxLength) <= 8) score += 10;
          if (/(phone|mobile|email|user(name)?|identifier|login|password)/i.test(searchText)) score -= 80;
          return { handle, score };
        })
        .sort((a, b) => b.score - a.score);

      const target = ranked[0]?.handle || candidates[0]?.handle;
      if (target) {
        await target.click({ clickCount: 3 }).catch(() => {});
        try {
          await target.type(digits, { delay: 80 });
        } catch {
          await target.evaluate((node, nextValue) => {
            const proto = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
            const setValue = descriptor && typeof descriptor.set === 'function'
              ? descriptor.set.bind(node)
              : (v) => { node.value = v; };
            node.focus();
            setValue('');
            node.dispatchEvent(new Event('input', { bubbles: true }));
            setValue(String(nextValue || ''));
            node.dispatchEvent(new Event('input', { bubbles: true }));
            node.dispatchEvent(new Event('change', { bubbles: true }));
          }, digits);
        }
      } else {
        await this.page.keyboard.type(digits, { delay: 80 });
      }
    }

    await sleep(1000);
    await this.clickSubmitButton();
  }

  isAddPhonePage(pageInfo) {
    const text = `${pageInfo.url}\n${pageInfo.text}`.toLowerCase();
    const hasPhoneInput = pageInfo.inputs.some((input) => input.name === 'phoneNumberInput' || input.type === 'tel');
    return (
      /add[-_]phone|add phone|phone verification|verify your phone|娣诲姞鎵嬫満鍙穦娣诲姞鎵嬫満|娣诲姞鐢佃瘽鍙风爜/.test(text)
      || (hasPhoneInput && /add|verify|娣诲姞|楠岃瘉/.test(text) && /phone|鎵嬫満鍙穦鎵嬫満|鐢佃瘽鍙风爜/.test(text))
    );
  }

  isAccountDeactivatedPage(pageInfo) {
    const text = `${pageInfo?.url || ''}\n${pageInfo?.text || ''}`.toLowerCase();
    return (
      /account_deactivated/.test(text)
      || /account (?:has been )?(?:deleted|deactivated|disabled)/.test(text)
      || /you do not have an account/.test(text)
      || /\u4f60\u6ca1\u6709\u8d26\u6237|\u60a8\u6c92\u6709\u5e33\u6236|\u8be5\u8d26\u6237\u5df2\u88ab\u5220\u9664\u6216\u505c\u7528|\u8a72\u8cec\u6236\u5df2\u88ab\u522a\u9664\u6216\u505c\u7528|\u8d26\u6237\u5df2\u88ab\u5220\u9664\u6216\u505c\u7528/.test(text)
    );
  }

  async screenshot(name) {
    try {
      if (!fs.existsSync(this.screenshotDir)) fs.mkdirSync(this.screenshotDir, { recursive: true });
      const filePath = path.join(this.screenshotDir, name);
      await this.page.screenshot({ path: filePath });
      return filePath;
    } catch {
      return null;
    }
  }

  async authorizeWithEmailOtp({ authUrl, email, mailProvider, redirectUri }) {
    const redirectBase = new URL(redirectUri);
    let callbackUrl = '';
    const requestListener = (request) => {
      const reqUrl = request.url();
      try {
        const parsed = new URL(reqUrl);
        if (
          parsed.hostname === redirectBase.hostname
          && parsed.port === redirectBase.port
          && parsed.pathname === redirectBase.pathname
          && (parsed.searchParams.has('code') || parsed.searchParams.has('error'))
        ) {
          callbackUrl = reqUrl;
        }
      } catch {
        // Ignore non-URL requests.
      }
    };

    this.page.on('request', requestListener);
    try {
      await this.page.goto(authUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await this.waitForCloudflare();
      await sleep(4000);

      let lastHandledUrl = '';
      for (let round = 0; round < 36; round += 1) {
        await sleep(2500);
        if (callbackUrl) return { status: 'callback', callbackUrl };

        let pageInfo;
        try {
          pageInfo = await this.getPageInfo();
        } catch {
          lastHandledUrl = '';
          continue;
        }

        if (callbackUrl) return { status: 'callback', callbackUrl };
        if (this.isAddPhonePage(pageInfo)) {
          await this.screenshot('add-phone.png');
          throw new AddPhoneRequiredError();
        }
        if (this.isAccountDeactivatedPage(pageInfo)) {
          await this.screenshot('account-deactivated.png');
          throw new AccountDeactivatedError();
        }

        try {
          const current = new URL(pageInfo.url);
          if (
            current.hostname === redirectBase.hostname
            && current.port === redirectBase.port
            && current.pathname === redirectBase.pathname
            && (current.searchParams.has('code') || current.searchParams.has('error'))
          ) {
            return { status: 'callback', callbackUrl: pageInfo.url };
          }
        } catch {
          // Continue.
        }

        if (/chrome-error/i.test(pageInfo.url) && callbackUrl) {
          return { status: 'callback', callbackUrl };
        }

        if (/went wrong|鍑洪敊浜唡missing_email|error/i.test(pageInfo.text)) {
          const clickedRetry = await this.clickByText(['Retry', 'Try again', '閲嶈瘯'], 3000);
          if (clickedRetry) {
            lastHandledUrl = '';
            await this.waitForCloudflare(30000).catch(() => {});
            continue;
          }
        }

        if (pageInfo.url === lastHandledUrl) continue;
        console.log(`[浏览器] 第 ${round} 轮：${pageInfo.url.substring(0, 90)}`);

        if (pageInfo.buttons.some((button) => textMatchesAny(button, EMAIL_LOGIN_TEXTS))) {
          await this.clickByText(EMAIL_LOGIN_TEXTS, 5000);
          lastHandledUrl = pageInfo.url;
          continue;
        }

        const hasEmailInput = pageInfo.inputs.some((input) => input.type === 'email' || ['email', 'username', 'identifier'].includes(input.name));
        if (hasEmailInput) {
          console.log(`[浏览器] 输入邮箱：${email}`);
          await this.fillInput([
            'input[type="email"]',
            'input[name="email"]',
            'input[name="username"]',
            'input[name="identifier"]',
            'input[type="text"]',
          ], email);
          await this.page.keyboard.press('Enter').catch(() => {});
          await sleep(1000);
          await this.clickSubmitButton();
          await this.waitForCloudflare(30000).catch(() => {});
          lastHandledUrl = pageInfo.url;
          continue;
        }

        const hasPassword = pageInfo.inputs.some((input) => input.type === 'password') || /password/i.test(pageInfo.url);
        if (hasPassword) {
          const clickedOtp = await this.clickByXPath('/html/body/div/div/fieldset/form/div[2]/div[3]/div/button')
            || await this.clickByText(OTP_TEXTS, 5000);
          if (!clickedOtp) {
            throw new Error('密码页已显示，但未找到一次性验证码登录入口');
          }
          await sleep(1000);
          await this.waitForCloudflare(30000).catch(() => {});
          lastHandledUrl = pageInfo.url;
          continue;
        }

        if (isCodePage(pageInfo)) {
          console.log('[浏览器] 等待邮箱验证码');
          const code = await this.pollEmailCodeByBrowserPage(mailProvider, email, { limit: 20 });
          await this.keepMainPageVisible();
          await this.enterVerificationCode(code);
          await this.waitForCloudflare(30000).catch(() => {});
          lastHandledUrl = pageInfo.url;
          continue;
        }

        if (isConsentPage(pageInfo)) {
          console.log('[浏览器] 点击授权确认按钮');
          const clickedConsent = await this.clickByXPath('/html/body/div/div/fieldset/form/div[2]/div/div[2]/button')
            || await this.clickByText(['Allow', 'Authorize', 'Continue', '鍏佽', '鎺堟潈', '鍚屾剰', '缁х画'], 2500);
          if (clickedConsent) {
            await sleep(1000);
            if (callbackUrl) return { status: 'callback', callbackUrl };
            await this.waitForCloudflare(30000).catch(() => {});
            if (callbackUrl) return { status: 'callback', callbackUrl };
            lastHandledUrl = pageInfo.url;
            continue;
          }
        }

        const clickedConsent = await this.clickByText(['Allow', 'Authorize', 'Continue', '鍏佽', '鎺堟潈', '鍚屾剰', '缁х画'], 2500);
        if (clickedConsent) {
          lastHandledUrl = pageInfo.url;
        }

        if (round % 6 === 5) {
          await this.screenshot(`oauth-round-${round}.png`);
          console.log(`[浏览器] 页面内容：${pageInfo.text.substring(0, 180)}`);
        }
      }

      throw new Error('OpenAI OAuth 浏览器流程超时');
    } finally {
      if (typeof this.page.off === 'function') this.page.off('request', requestListener);
      else if (typeof this.page.removeListener === 'function') this.page.removeListener('request', requestListener);
    }
  }

  async readChatGptSession() {
    await this.page.goto('https://chatgpt.com', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await this.waitForCloudflare(60000).catch(() => {});
    await sleep(5000);

    const result = await this.page.evaluate(async () => {
      const response = await fetch('/api/auth/session', { credentials: 'include' });
      const session = await response.json().catch(() => ({}));
      return {
        ok: response.ok,
        status: response.status,
        session,
        accessToken: String(session?.accessToken || '').trim(),
      };
    });

    if (!result.ok && !result.accessToken) {
      throw new Error(`ChatGPT 会话接口失败：HTTP ${result.status || 'unknown'}`);
    }
    if (!result.accessToken) {
      throw new Error('ChatGPT 会话中没有 accessToken');
    }
    return result;
  }
}

module.exports = {
  BrowserAuth,
  AddPhoneRequiredError,
  AccountDeactivatedError,
};

