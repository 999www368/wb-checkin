#!/usr/bin/env node
/**
 * WorkBuddy 每日自动签到 —— 云端版（GitHub Actions）
 *
 * 和本地版 wb-checkin/checkin.mjs 的区别：
 *   - 本地版从 DSH 插件的明文 vault 读账号；云端没有那个 vault，改从环境变量 WB_ACCOUNTS 读。
 *   - 本地版刷新后写回 vault 文件；云端写回 state.enc（AES-256-GCM 加密后提交进仓库）。
 *
 * 环境变量：
 *   WB_ACCOUNTS  JSON 数组，首次导入用。每项 {accountId,name,uid,domain,accessToken,refreshToken}
 *   STATE_KEY    32 字节以上的口令，用来加解密 state.enc。换了它等于重置状态。
 *   STATE_FILE   state.enc 路径，默认 ./state.enc
 *   WB_FORCE_REFRESH=1  强制刷新 token（演练用）
 *
 * 退出码：0 正常；2 有账号失败；1 没有账号。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createCipheriv, createDecipheriv, randomBytes, createHash, scryptSync } from 'node:crypto';

const CN_BILLING_BASE = 'https://www.codebuddy.cn';
const CN_CHAT_BASE = 'https://copilot.tencent.com';
const CLIENT_UA = 'CLI/2.63.2 CodeBuddy/2.63.2';
const TIMEOUT_MS = 20000;
const REFRESH_MARGIN_SEC = 600;
const STATE_FILE = process.env.STATE_FILE || 'state.enc';
const LOG_FILE = process.env.LOG_FILE || 'checkin.log';

// ---------- 加密状态文件 ----------
// 格式：MAGIC(4) | salt(16) | iv(12) | tag(16) | ciphertext
// key = scrypt(STATE_KEY, salt, 32)。整个文件没有明文，提交进公开仓库也看不到 token。

const MAGIC = Buffer.from('WBC1', 'ascii');

function stateKey(salt) {
  const pass = process.env.STATE_KEY;
  if (!pass || pass.length < 16) throw new Error('STATE_KEY 缺失或太短（至少 16 字符）');
  return scryptSync(pass, salt, 32);
}

function encryptState(obj) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', stateKey(salt), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  return Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), body]);
}

function decryptState(buf) {
  if (buf.length < 48 || !buf.subarray(0, 4).equals(MAGIC)) throw new Error('state.enc 格式不对');
  const salt = buf.subarray(4, 20);
  const iv = buf.subarray(20, 32);
  const tag = buf.subarray(32, 48);
  const decipher = createDecipheriv('aes-256-gcm', stateKey(salt), iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(buf.subarray(48)), decipher.final()]);
  return JSON.parse(plain.toString('utf8'));
}

// ---------- 工具 ----------

function log(line) {
  const stamp = new Date().toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
  console.log(`[${stamp}] ${line}`);
}

function jwtPayload(token) {
  try {
    const part = String(token).split('.')[1];
    if (!part) return {};
    return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch {
    return {};
  }
}

async function postJson(url, headers, body = '{}') {
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch {
    envelope = { code: -1, msg: `非 JSON 响应: ${text.slice(0, 200)}` };
  }
  return { status: res.status, ok: res.ok, envelope };
}

function billingHeaders(acc) {
  return {
    Authorization: `Bearer ${acc.accessToken}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    ...(acc.uid ? { 'X-User-Id': acc.uid } : {}),
    ...(acc.domain ? { 'X-Domain': acc.domain } : {}),
  };
}

// ---------- 刷新 ----------

async function refresh(acc) {
  const headers = {
    Accept: 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    Origin: CN_BILLING_BASE,
    Referer: `${CN_BILLING_BASE}/`,
    'User-Agent': CLIENT_UA,
    'X-Refresh-Token': acc.refreshToken,
    'X-Auth-Refresh-Source': 'workbuddy',
  };
  const { status, ok, envelope } = await postJson(`${CN_CHAT_BASE}/v2/plugin/auth/token/refresh`, headers);
  const data = envelope?.data ?? {};
  if (!ok || envelope.code !== 0 || typeof data.accessToken !== 'string' || data.accessToken === '') {
    throw new Error(`refresh 失败 HTTP ${status} code=${envelope.code} msg=${envelope.msg ?? ''}`);
  }
  acc.accessToken = data.accessToken;
  if (typeof data.refreshToken === 'string' && data.refreshToken !== '') acc.refreshToken = data.refreshToken;
  acc.refreshedAt = new Date().toISOString();
  return jwtPayload(data.accessToken).exp;
}

// ---------- 单账号 ----------

async function checkinOne(acc) {
  const row = { accountId: acc.accountId, accountName: acc.name };

  const exp = jwtPayload(acc.accessToken).exp;
  const nowSec = Math.floor(Date.now() / 1000);
  const force = process.env.WB_FORCE_REFRESH === '1';
  if (force || typeof exp !== 'number' || exp - nowSec < REFRESH_MARGIN_SEC) {
    try {
      const newExp = await refresh(acc);
      row.refreshed = true;
      if (newExp) row.tokenExpiresAt = new Date(newExp * 1000).toISOString();
      log(`· ${acc.name || acc.accountId}：token 已刷新，新有效期 ${row.tokenExpiresAt ?? '未知'}`);
    } catch (e) {
      return { ...row, status: 'failed', message: `token 刷新失败：${e.message}` };
    }
  }

  let status;
  try {
    const r = await postJson(`${CN_BILLING_BASE}/v2/billing/meter/checkin-activity-status`, billingHeaders(acc));
    if (!r.ok || r.envelope.code !== 0) {
      return { ...row, status: 'failed', message: `查状态失败 HTTP ${r.status} code=${r.envelope.code} msg=${r.envelope.msg ?? ''}` };
    }
    status = r.envelope.data ?? {};
  } catch (e) {
    return { ...row, status: 'failed', message: `查状态异常：${e.message}` };
  }

  row.streakDays = status.streak_days ?? 0;
  row.dailyCredit = status.daily_credit ?? 0;

  if (status.active !== true) return { ...row, status: 'skipped', message: '当前没有签到活动' };
  if (status.today_checked_in === true) return { ...row, status: 'already', message: `今天已签到，连续 ${row.streakDays} 天` };

  try {
    const r = await postJson(`${CN_BILLING_BASE}/v2/billing/meter/daily-checkin`, billingHeaders(acc));
    if (!r.ok || r.envelope.code !== 0) {
      return { ...row, status: 'failed', message: `领取失败 HTTP ${r.status} code=${r.envelope.code} msg=${r.envelope.msg ?? ''}` };
    }
    const data = r.envelope.data ?? {};
    return {
      ...row,
      status: 'claimed',
      credit: data.credit ?? 0,
      streakDays: data.streak_days ?? row.streakDays,
      message: `签到成功 +${data.credit ?? 0} 积分，连续 ${data.streak_days ?? row.streakDays} 天`,
    };
  } catch (e) {
    return { ...row, status: 'failed', message: `领取异常：${e.message}` };
  }
}

// ---------- 主流程 ----------

const startedAt = new Date().toISOString();
let state;

if (existsSync(STATE_FILE)) {
  try {
    state = decryptState(await readFile(STATE_FILE));
  } catch (e) {
    log(`读 ${STATE_FILE} 失败：${e.message}`);
    process.exit(2);
  }
} else {
  const raw = process.env.WB_ACCOUNTS;
  if (!raw) {
    log('首次运行需要 WB_ACCOUNTS 环境变量（账号 JSON 数组）');
    process.exit(1);
  }
  const parsed = JSON.parse(raw);
  const list = Array.isArray(parsed) ? parsed : [parsed];
  state = { version: 1, accounts: list };
  log(`首次导入 ${list.length} 个账号，生成加密状态文件`);
}

const accounts = (state.accounts ?? []).filter((a) => String(a.domain ?? '').includes('workbuddy.cn'));

if (accounts.length === 0) {
  log('没有国内区账号（国际区 www.workbuddy.ai 没有签到活动）');
  await writeFile('last-result.json', JSON.stringify({ startedAt, rows: [], note: 'no cn accounts' }, null, 2));
  process.exit(1);
}

log(`开始签到，共 ${accounts.length} 个国内区账号`);
const rows = [];
for (let i = 0; i < accounts.length; i++) {
  const row = await checkinOne(accounts[i]);
  rows.push(row);
  const tag = { claimed: '✓', already: '·', skipped: '-', failed: '✗' }[row.status] ?? '?';
  log(`${tag} ${row.accountName || row.accountId}：${row.message}`);
  if (i < accounts.length - 1) await new Promise((r) => setTimeout(r, 500));
}

const claimed = rows.filter((r) => r.status === 'claimed').length;
const totalCredit = rows.reduce((n, r) => n + (r.credit ?? 0), 0);
const failed = rows.filter((r) => r.status === 'failed').length;
log(`结束：${claimed} 个新签到，共 +${totalCredit} 积分，${failed} 个失败`);

// 状态写回（token 可能已轮转）
state.accounts = accounts;
state.updatedAt = new Date().toISOString();
await writeFile(STATE_FILE, encryptState(state));

const summary = {
  startedAt,
  finishedAt: new Date().toISOString(),
  claimed,
  totalCredit,
  failed,
  accounts: accounts.map((a) => ({ id: a.accountId, name: a.name })),
  rows,
};
await writeFile('last-result.json', JSON.stringify(summary, null, 2));

// 供手机页面读取的精简版（不含 token、不含账号 id）
const publicSummary = {
  updatedAt: summary.finishedAt,
  claimed,
  totalCredit,
  failed,
  rows: rows.map((r) => ({
    name: r.accountName || '账号',
    status: r.status,
    message: r.message,
    streakDays: r.streakDays ?? null,
  })),
};
await mkdir('docs', { recursive: true }).catch(() => {});
await writeFile('docs/status.json', JSON.stringify(publicSummary, null, 2));

await writeFile(
  LOG_FILE,
  `${''}${startedAt} claimed=${claimed} credit=${totalCredit} failed=${failed}\n`,
  { encoding: 'utf8', flag: 'a' },
);
process.exit(failed > 0 ? 2 : 0);
