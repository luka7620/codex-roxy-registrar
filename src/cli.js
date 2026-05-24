const { loadConfig } = require('./config');
const { Sub2ApiClient } = require('./sub2apiClient');
const { MailProvider } = require('./mailProvider');
const { BrowserAuth, AddPhoneRequiredError, AccountDeactivatedError } = require('./browserAuth');
const { mergeOAuthCredentials, buildSessionAtCredentials, buildUpdatedExtra } = require('./sessionCredentials');
const { writeTokenFiles } = require('./tokenWriter');
const { appendReauthLog } = require('./reauthLog');
const readline = require('node:readline/promises');

function getArgValue(args, name) {
  const index = args.indexOf(name);
  if (index >= 0) return args[index + 1] || '';
  const prefixed = args.find((arg) => arg.startsWith(`${name}=`));
  return prefixed ? prefixed.slice(name.length + 1) : '';
}

function hasFlag(args, name) {
  return args.includes(name);
}

function isYesAnswer(value) {
  return /^y(?:es)?$/i.test(String(value || '').trim());
}

function isInteractiveMode(args) {
  return hasFlag(args, '--interactive') || hasFlag(args, '--confirm');
}

function includesIgnoreCase(value, expected) {
  return String(value || '').toLowerCase().includes(String(expected || '').toLowerCase());
}

function getGroupNames(account) {
  return (Array.isArray(account.groups) ? account.groups : [])
    .map((group) => String(group?.name || '').trim())
    .filter(Boolean);
}

function getPlanType(account) {
  const direct = String(account?.credentials?.plan_type || account?.credentials?.chatgpt_plan_type || '').trim().toLowerCase();
  if (direct) return direct;
  const names = [account?.name, ...getGroupNames(account)].join(' ').toLowerCase();
  if (names.includes('plus')) return 'plus';
  if (names.includes('free')) return 'free';
  return '';
}

function getEmail(account) {
  return String(account?.credentials?.email || account?.email || '').trim();
}

function isOpenAiOauthAccount(account) {
  return String(account?.platform || '').toLowerCase() === 'openai'
    && String(account?.type || '').toLowerCase() === 'oauth';
}

function needsReauth(account, config) {
  const message = `${account?.error_message || ''}\n${account?.temp_unschedulable_reason || ''}`;
  if (!message.trim()) return false;
  return config.candidateErrorKeywords.some((keyword) => includesIgnoreCase(message, keyword));
}

function passesFilters(account, filters) {
  if (filters.email && getEmail(account).toLowerCase() !== filters.email.toLowerCase()) return false;
  if (filters.plan && getPlanType(account) !== filters.plan.toLowerCase()) return false;
  if (filters.groupId) {
    const id = Number(filters.groupId);
    if (!Array.isArray(account.group_ids) || !account.group_ids.some((groupId) => Number(groupId) === id)) return false;
  }
  if (filters.group) {
    const needle = filters.group.toLowerCase();
    if (!getGroupNames(account).some((name) => name.toLowerCase().includes(needle))) return false;
  }
  return true;
}

function normalizePreferredGroups(filters, config) {
  const names = [
    ...config.preferredGroupNames,
    ...(filters.preferGroup ? [filters.preferGroup] : []),
  ]
    .map((name) => String(name || '').trim().toLowerCase())
    .filter(Boolean);
  const ids = [
    ...config.preferredGroupIds,
    ...(filters.preferGroupId ? [filters.preferGroupId] : []),
  ]
    .map((id) => Number(id))
    .filter((id) => Number.isFinite(id) && id > 0);
  return { names, ids };
}

function getPreferredScore(account, preferred) {
  let score = 0;
  const groupNames = getGroupNames(account).map((name) => name.toLowerCase());
  const groupIds = Array.isArray(account.group_ids) ? account.group_ids.map((id) => Number(id)) : [];

  if (preferred.names.length && groupNames.some((name) => preferred.names.some((needle) => name.includes(needle)))) {
    score += 1000;
  }
  if (preferred.ids.length && groupIds.some((id) => preferred.ids.includes(id))) {
    score += 1000;
  }
  return score;
}

function sortCandidates(candidates, filters, config) {
  const preferred = normalizePreferredGroups(filters, config);
  return [...candidates].sort((a, b) => {
    const scoreDiff = getPreferredScore(b, preferred) - getPreferredScore(a, preferred);
    if (scoreDiff !== 0) return scoreDiff;
    const planDiff = (getPlanType(b) === 'plus' ? 1 : 0) - (getPlanType(a) === 'plus' ? 1 : 0);
    if (planDiff !== 0) return planDiff;
    return Number(a.id || 0) - Number(b.id || 0);
  });
}

function formatCandidateLine(account, index = null) {
  const prefix = Number.isInteger(index) ? `[${index}] ` : '';
  return [
    `${prefix}编号=${account.id}`,
    `名称="${account.name || ''}"`,
    `邮箱=${getEmail(account)}`,
    `套餐=${getPlanType(account) || '未知'}`,
    `分组=${getGroupNames(account).join('|') || '无'}`,
    `状态=${account.status || '未知'}`,
    `错误="${account.error_message || account.temp_unschedulable_reason || ''}"`,
  ].join(' ');
}

async function promptLine(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = await rl.question(question);
    return String(answer || '').trim();
  } finally {
    rl.close();
  }
}

function pickCandidateFromInput(input, candidates) {
  const value = String(input || '').trim();
  if (!value) return null;

  if (/^\d+$/.test(value)) {
    const numeric = Number(value);
    if (numeric >= 1 && numeric <= candidates.length) {
      return candidates[numeric - 1];
    }
  }

  const byId = candidates.find((account) => String(account.id) === value);
  if (byId) return byId;

  const byEmail = candidates.find((account) => getEmail(account).toLowerCase() === value.toLowerCase());
  if (byEmail) return byEmail;

  return undefined;
}

async function selectCandidateInteractively(candidates) {
  if (!candidates.length) return null;

  console.log('[扫描] 匹配到的待处理账号：');
  candidates.forEach((account, index) => {
    console.log(formatCandidateLine(account, index + 1));
  });

  if (candidates.length === 1) {
    const account = candidates[0];
    const answer = await promptLine(
      `[确认] 是否开始处理 编号=${account.id} 邮箱=${getEmail(account)}？[y/N]: `
    );
    return isYesAnswer(answer) ? account : null;
  }

  while (true) {
    const answer = await promptLine('输入序号 / 编号 / 邮箱（直接回车取消）： ');
    if (!answer) return null;
    const selected = pickCandidateFromInput(answer, candidates);
    if (!selected) {
      console.log('[提示] 选择无效，请重试。');
      continue;
    }

    const confirm = await promptLine(
      `[确认] 是否开始处理 编号=${selected.id} 邮箱=${getEmail(selected)}？[y/N]: `
    );
    return isYesAnswer(confirm) ? selected : null;
  }
}

async function selectCandidatesInteractively(candidates) {
  if (!candidates.length) return [];

  console.log('[扫描] 匹配到的待处理账号：');
  candidates.forEach((account, index) => {
    console.log(formatCandidateLine(account, index + 1));
  });

  if (candidates.length === 1) {
    const account = candidates[0];
    const answer = await promptLine(
      `[确认] 是否开始处理 编号=${account.id} 邮箱=${getEmail(account)}？[y/N]: `
    );
    return isYesAnswer(answer) ? { accounts: [account], batch: false } : { accounts: [], batch: false };
  }

  while (true) {
    const answer = await promptLine('输入序号 / 编号 / 邮箱，或输入 all 全部处理（直接回车取消）： ');
    if (!answer) return { accounts: [], batch: false };

    if (/^all$/i.test(answer)) {
      const confirm = await promptLine(`[确认] 是否一次性处理全部 ${candidates.length} 个账号？[y/N]: `);
      return isYesAnswer(confirm)
        ? { accounts: candidates, batch: true }
        : { accounts: [], batch: false };
    }

    const selected = pickCandidateFromInput(answer, candidates);
    if (!selected) {
      console.log('[提示] 选择无效，请重试。');
      continue;
    }

    const confirm = await promptLine(
      `[确认] 是否开始处理 编号=${selected.id} 邮箱=${getEmail(selected)}？[y/N]: `
    );
    return isYesAnswer(confirm)
      ? { accounts: [selected], batch: false }
      : { accounts: [], batch: false };
  }
}

async function resolveInteractiveTargetAccount(client, config, filters) {
  if (filters.accountId) {
    const account = await client.getAccount(filters.accountId);
    if (!isOpenAiOauthAccount(account)) throw new Error(`Account ${filters.accountId} is not an OpenAI OAuth account`);
    if (!getEmail(account)) throw new Error(`Account ${filters.accountId} has no credentials.email`);

    console.log('[扫描] 已选账号：');
    console.log(formatCandidateLine(account));

    const answer = await promptLine(
      `[确认] 是否开始处理 编号=${account.id} 邮箱=${getEmail(account)}？[y/N]: `
    );
    return isYesAnswer(answer) ? account : null;
  }

  const candidates = await findCandidates(client, config, filters);
  if (!candidates.length) {
    throw new Error('No matching reauth candidates found');
  }

  return selectCandidateInteractively(candidates);
}

async function resolveInteractiveTargetAccounts(client, config, filters) {
  if (filters.accountId || filters.email) {
    const account = await resolveInteractiveTargetAccount(client, config, filters);
    return account ? { accounts: [account], batch: false } : { accounts: [], batch: false };
  }

  const candidates = await findCandidates(client, config, filters);
  if (!candidates.length) {
    throw new Error('No matching reauth candidates found');
  }

  return selectCandidatesInteractively(candidates);
}

function parseCallbackParams(callbackUrl) {
  const parsed = new URL(callbackUrl);
  const code = parsed.searchParams.get('code') || '';
  const state = parsed.searchParams.get('state') || '';
  const error = parsed.searchParams.get('error') || '';
  const errorDescription = parsed.searchParams.get('error_description') || '';
  if (error) throw new Error(errorDescription || error);
  if (!code) throw new Error('OAuth callback is missing code');
  return { code, state };
}

async function findCandidates(client, config, filters) {
  const [errorAccounts, tempAccounts] = await Promise.all([
    client.listAllAccounts({ type: 'oauth', status: 'error', page_size: 100 }),
    client.listAllAccounts({ type: 'oauth', status: 'temp_unschedulable', page_size: 100 }),
  ]);

  const byId = new Map();
  for (const item of [...errorAccounts, ...tempAccounts]) {
    if (item?.id !== undefined && item?.id !== null) byId.set(String(item.id), item);
  }

  const candidates = [];
  for (const partial of byId.values()) {
    const detail = partial.credentials && partial.groups
      ? partial
      : await client.getAccount(partial.id);
    if (!isOpenAiOauthAccount(detail)) continue;
    if (!needsReauth(detail, config)) continue;
    if (!getEmail(detail)) continue;
    if (!passesFilters(detail, filters)) continue;
    candidates.push(detail);
  }
  return sortCandidates(candidates, filters, config);
}

async function resolveTargetAccount(client, config, filters) {
  if (filters.accountId) {
    const account = await client.getAccount(filters.accountId);
    if (!isOpenAiOauthAccount(account)) throw new Error(`Account ${filters.accountId} is not an OpenAI OAuth account`);
    if (!getEmail(account)) throw new Error(`Account ${filters.accountId} has no credentials.email`);
    return account;
  }

  const candidates = await findCandidates(client, config, filters);
  if (!candidates.length) {
    throw new Error('No matching reauth candidates found');
  }
  return candidates[0];
}

async function resolveTargetAccounts(client, config, filters) {
  if (filters.accountId || filters.email) {
    return [await resolveTargetAccount(client, config, filters)];
  }

  const candidates = await findCandidates(client, config, filters);
  if (!candidates.length) {
    throw new Error('No matching reauth candidates found');
  }
  return candidates;
}

function buildLogBase(account) {
  return {
    accountId: account.id,
    name: account.name || '',
    email: getEmail(account),
    oldStatus: account.status || '',
    errorMessage: account.error_message || account.temp_unschedulable_reason || '',
    groupIds: Array.isArray(account.group_ids) ? account.group_ids : [],
    groupNames: getGroupNames(account),
    planType: getPlanType(account),
    proxyId: account.proxy_id || null,
  };
}

function isSkippableReauthError(error) {
  return (
    error instanceof AccountDeactivatedError
    || error?.code === 'ACCOUNT_DEACTIVATED'
  );
}

function getSkipReason(error) {
  if (error instanceof AccountDeactivatedError || error?.code === 'ACCOUNT_DEACTIVATED') {
    return 'account_deactivated';
  }
  return 'skipped';
}

function logSkippedReauth(account, config, startedAt, error) {
  const finishedAt = new Date().toISOString();
  const reason = getSkipReason(error);
  const logPath = appendReauthLog(config.reauthLogFile, {
    ...buildLogBase(account),
    result: `skipped_${reason}`,
    authMode: 'email_otp',
    startedAt,
    finishedAt,
    error: error.message,
  });
  console.warn(`[重授权] 已跳过账号 编号=${account.id} 邮箱=${getEmail(account)} 原因=${reason} 日志=${logPath}`);
  return { skipped: true, reason, logPath };
}

function formatDurationMs(ms) {
  const totalSeconds = Math.max(0, Math.round(Number(ms) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) return `${seconds}秒`;
  return `${minutes}分${String(seconds).padStart(2, '0')}秒`;
}

async function processAccountsQueue(accounts, { client, mailProvider, config }) {
  const summary = {
    total: accounts.length,
    success: 0,
    failed: 0,
    skipped: 0,
  };
  const startedAt = Date.now();

  console.log(`[队列] 开始批量处理，共 ${accounts.length} 个账号`);

  for (let index = 0; index < accounts.length; index += 1) {
    const account = accounts[index];
    console.log(`[队列] 处理 ${index + 1}/${accounts.length}：${formatCandidateLine(account)}`);

    try {
      const result = await reauthorizeAccount(account, { client, mailProvider, config });
      if (result?.skipped) {
        summary.skipped += 1;
        console.log(`[队列] 已跳过：编号=${account.id} 邮箱=${getEmail(account)} 原因=${result.reason || '未知'}`);
        continue;
      }

      summary.success += 1;
      console.log(`[队列] 处理成功：编号=${account.id} 邮箱=${getEmail(account)}`);
    } catch (error) {
      summary.failed += 1;
      console.warn(`[队列] 处理失败：编号=${account.id} 邮箱=${getEmail(account)} 原因=${error.message}`);
    }
  }

  console.log(
    `[汇总] 总计 ${summary.total} 个，成功 ${summary.success}，失败 ${summary.failed}，跳过 ${summary.skipped}，耗时 ${formatDurationMs(Date.now() - startedAt)}`
  );
  return summary;
}

async function updateSuccess({ client, config, account, credentials, extra, result, startedAt }) {
  await client.updateAccount(account.id, account, credentials, extra);
  await client.clearError(account.id);
  const tokenWrite = writeTokenFiles(credentials, config);
  const finishedAt = new Date().toISOString();
  const logPath = appendReauthLog(config.reauthLogFile, {
    ...buildLogBase(account),
    result,
    authMode: credentials.auth_mode || '',
    hasRefreshToken: Boolean(credentials.refresh_token),
    tokenFiles: tokenWrite.savedPaths,
    startedAt,
    finishedAt,
  });
  return { tokenWrite, logPath };
}

async function reauthorizeAccount(account, { client, mailProvider, config }) {
  const email = getEmail(account);
  const planType = getPlanType(account);
  const startedAt = new Date().toISOString();
  const proxyId = account.proxy_id || undefined;

  console.log(`[重授权] 开始处理 编号=${account.id} 名称="${account.name}" 邮箱=${email} 套餐=${planType || '未知'} 代理=${proxyId || '无'}`);

  const browser = new BrowserAuth(config);
  await browser.launch();
  try {
    const authSession = await client.generateOpenAiAuthUrl({
      proxyId,
      redirectUri: config.oauthRedirectUri,
    });
    if (!authSession?.auth_url || !authSession?.session_id) {
      throw new Error('generate-auth-url 没有返回 auth_url/session_id');
    }

    let authResult;
    try {
      authResult = await browser.authorizeWithEmailOtp({
        authUrl: authSession.auth_url,
        email,
        mailProvider,
        redirectUri: config.oauthRedirectUri,
      });
    } catch (error) {
      if (isSkippableReauthError(error)) {
        return logSkippedReauth(account, config, startedAt, error);
      }

      if (!(error instanceof AddPhoneRequiredError || error?.code === 'ADD_PHONE_REQUIRED')) {
        throw error;
      }

      if (planType !== 'plus') {
        const finishedAt = new Date().toISOString();
        const logPath = appendReauthLog(config.reauthLogFile, {
          ...buildLogBase(account),
          result: 'skipped_add_phone_free',
          authMode: 'email_otp',
          startedAt,
          finishedAt,
          error: error.message,
        });
        console.warn(`[重授权] 免费/非 Plus 账号要求手机号验证，已跳过。日志=${logPath}`);
        return { skipped: true, reason: 'add_phone', logPath };
      }

      console.warn('[重授权] Plus 账号遇到手机号验证，改用 ChatGPT session access token');
      const sessionState = await browser.readChatGptSession();
      const credentials = buildSessionAtCredentials({
        account,
        session: sessionState.session,
        accessToken: sessionState.accessToken,
        forcePlanType: 'plus',
      });
      const extra = buildUpdatedExtra(account.extra, {}, 'session_at');
      const success = await updateSuccess({
        client,
        config,
        account,
        credentials,
        extra,
        result: 'success_session_at',
        startedAt,
      });
      console.log(`[重授权] Plus session AT 已更新。token=${success.tokenWrite.savedPaths.join(' | ')}`);
      return { ok: true, mode: 'session_at', ...success };
    }

    if (!authResult || authResult.status !== 'callback') {
      throw new Error(`浏览器授权结果异常：${JSON.stringify(authResult)}`);
    }

    const callbackParams = parseCallbackParams(authResult.callbackUrl);
    const exchangeData = await client.exchangeOpenAiCode({
      sessionId: authSession.session_id,
      code: callbackParams.code,
      state: callbackParams.state,
      redirectUri: config.oauthRedirectUri,
      proxyId,
    });
    const credentials = mergeOAuthCredentials(account.credentials || {}, exchangeData);
    const extra = buildUpdatedExtra(account.extra, exchangeData, 'oauth');
    const success = await updateSuccess({
      client,
      config,
      account,
      credentials,
      extra,
      result: 'success_oauth',
      startedAt,
    });
    console.log(`[重授权] OAuth 凭据已更新。token=${success.tokenWrite.savedPaths.join(' | ')}`);
    return { ok: true, mode: 'oauth', ...success };
  } catch (error) {
    const finishedAt = new Date().toISOString();
    const logPath = appendReauthLog(config.reauthLogFile, {
      ...buildLogBase(account),
      result: 'failed',
      startedAt,
      finishedAt,
      error: error.message,
    });
    console.error(`[重授权] 处理失败：${error.message}。日志=${logPath}`);
    throw error;
  } finally {
    await browser.close();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const config = loadConfig();
  const interactiveMode = isInteractiveMode(args);
  const filters = {
    accountId: getArgValue(args, '--account-id'),
    email: getArgValue(args, '--email'),
    plan: getArgValue(args, '--plan'),
    group: getArgValue(args, '--group'),
    groupId: getArgValue(args, '--group-id'),
    preferGroup: getArgValue(args, '--prefer-group'),
    preferGroupId: getArgValue(args, '--prefer-group-id'),
  };

  const client = new Sub2ApiClient({
    baseUrl: config.sub2apiBaseUrl,
    adminEmail: config.sub2apiAdminEmail,
    adminPassword: config.sub2apiAdminPassword,
    turnstileToken: config.sub2apiTurnstileToken,
  });

  if (hasFlag(args, '--list-candidates')) {
    const candidates = await findCandidates(client, config, filters);
    for (const account of candidates) {
      console.log(formatCandidateLine(account));
    }
    console.log(`[列表] 总数=${candidates.length}`);
    return;
  }

  if (!filters.accountId && !filters.email && !hasFlag(args, '--auto') && !interactiveMode) {
    throw new Error('Pass --account-id <id>, --email <email>, --auto, --interactive, --confirm, or --list-candidates');
  }

  const mailProvider = new MailProvider({
    baseUrl: config.mailBaseUrl,
    adminPassword: config.mailAdminPassword,
    sitePassword: config.mailSitePassword,
    domain: config.mailDomain,
    timeoutMs: config.mailTimeoutMs,
  });

  if (interactiveMode) {
    const selection = await resolveInteractiveTargetAccounts(client, config, filters);
    const accounts = Array.isArray(selection?.accounts) ? selection.accounts : [];
    if (!accounts.length) {
      console.log('[交互] 已取消');
      return;
    }
    if (selection.batch) {
      await processAccountsQueue(accounts, { client, mailProvider, config });
      return;
    }

    const result = await reauthorizeAccount(accounts[0], { client, mailProvider, config });
    if (result?.skipped) {
      console.log(`[交互] 账号已跳过：编号=${accounts[0].id} 邮箱=${getEmail(accounts[0])}`);
      return;
    }
    return;
  }

  const account = await resolveTargetAccount(client, config, filters);
  await reauthorizeAccount(account, { client, mailProvider, config });
}

module.exports = {
  main,
  findCandidates,
  reauthorizeAccount,
};
