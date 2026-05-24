const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function stripHtmlTags(value = '') {
  return String(value || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function collectTextCandidates(input) {
  const source = typeof input === 'string'
    ? input
    : [
      input?.raw,
      input?.body,
      input?.html,
      input?.text,
      input?.content,
      input?.subject,
      input?.title,
      input?.preview,
      input?.snippet,
      input?.summary,
      input?.headers?.subject,
    ]
      .filter((value) => typeof value === 'string' && value.trim())
      .join('\n\n');

  if (!source) return [];

  const candidates = [source];
  const htmlMatch = source.match(/Content-Type:\s*text\/html[\s\S]*?\r?\n\r?\n([\s\S]*?)(?:--[^\r\n]+--|$)/i);
  if (htmlMatch && htmlMatch[1]) {
    candidates.push(htmlMatch[1]);
  } else {
    const parts = source.split(/\r?\n\r?\n/);
    if (parts.length > 1) {
      candidates.push(parts.slice(Math.max(1, parts.length - 3)).join('\n'));
    }
  }

  candidates.push(stripHtmlTags(source));
  if (htmlMatch && htmlMatch[1]) {
    candidates.push(stripHtmlTags(htmlMatch[1]));
  }

  return [...new Set(candidates.map((value) => String(value || '').trim()).filter(Boolean))];
}

function extractVerificationCodeFromText(text = '') {
  if (!text || typeof text !== 'string') return null;

  const codePatterns = [
    /(?:code|verification|verify|otp|passcode|security code|one[-\s]?time(?:\s+code)?|email code|verification code|\u9a8c\u8bc1\u7801|\u9a8c\u8b49\u78bc|\u4e00\u6b21\u6027)[^\d]{0,60}(\d{6})/i,
    /(\d{6})[^\d]{0,60}(?:code|verification|verify|otp|passcode|security code|one[-\s]?time(?:\s+code)?|email code|verification code|\u9a8c\u8bc1\u7801|\u9a8c\u8b49\u78bc|\u4e00\u6b21\u6027)/i,
    />\s*(\d{6})\s*</,
  ];

  for (const pattern of codePatterns) {
    const match = text.match(pattern);
    if (match) return match[1];
  }

  const allSixDigits = text.match(/\b(\d{6})\b/g) || [];
  const filtered = allSixDigits.filter((digits) => !text.includes(`t=${digits}`) && !text.includes(`x=${digits}`));
  return filtered.length > 0 ? filtered[0] : null;
}

function extractVerificationCodeFromMailRaw(raw = '') {
  const candidates = collectTextCandidates(raw);
  for (const candidate of candidates) {
    const code = extractVerificationCodeFromText(candidate);
    if (code) return code;
  }
  return null;
}

async function pollEmailCodeByAddress(mailProvider, email, options = {}) {
  const maxAttempts = Number(options.maxAttempts) || 30;
  const intervalMs = Number(options.intervalMs) || 5000;
  const limit = Number(options.limit) > 0 ? Number(options.limit) : 10;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    console.log(`[mail] polling ${email} for verification code (${attempt}/${maxAttempts})`);
    try {
      const mails = await mailProvider.getMailsByAddress(email, limit, 0);
      if (Array.isArray(mails) && mails.length > 0) {
        for (const mail of mails) {
          const code = extractVerificationCodeFromMailRaw(mail);
          if (code) {
            console.log(`[mail] code received for ${email}`);
            return code;
          }
        }
        const firstMail = mails[0];
        const preview = extractVerificationCodeFromMailRaw(firstMail) || '';
        if (!preview) {
          const subject = String(firstMail?.subject || firstMail?.title || '').trim();
          console.log(`[mail] mails received for ${email} but no code matched yet${subject ? ` (subject="${subject.slice(0, 80)}")` : ''}`);
        }
      }
    } catch (error) {
      console.warn(`[mail] polling failed: ${error.message}`);
    }
    await sleep(intervalMs);
  }

  throw new Error(`${email} email code timeout`);
}

module.exports = {
  extractVerificationCodeFromMailRaw,
  pollEmailCodeByAddress,
};
