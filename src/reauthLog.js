const fs = require('fs');
const path = require('path');

function readJsonArray(filePath) {
  if (!fs.existsSync(filePath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === 'object') return [parsed];
  } catch {
    return [];
  }
  return [];
}

function appendReauthLog(filePath, entry) {
  const resolved = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
  const dir = path.dirname(resolved);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const list = readJsonArray(resolved);
  list.push(entry);
  fs.writeFileSync(resolved, JSON.stringify(list, null, 2));
  return resolved;
}

module.exports = { appendReauthLog };
