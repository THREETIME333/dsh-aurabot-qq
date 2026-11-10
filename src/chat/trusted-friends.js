// 信任好友名单：主人点名让某个人操作电脑。
// 主名单是一份 JSON 文件（~/.dsh/plugins-data/aurabot/trustedFriends.json），
// 大肥鱼自己在主人私聊里用 manage-trusted-friends 工具维护；面板配置里的
// trustedFriends 只做查看/备用。levelFor 每次收到消息都重新读这份文件，
// 名单改完下一条消息就生效，不用重启。名单先留空，不预设任何人；谁能进名单由主人说了算。
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { dataDir, readJson, writeJson } from '../core/store.js'

export const TRUSTED_FRIENDS_FILE = 'trustedFriends.json'
export const TRUSTED_FRIENDS_LOG = 'trustedFriends.log'
/** 信任好友第一档：跑命令 + 读写文件。不要定时任务（jobs/schedule），不要联网（web）。 */
export const TRUSTED_DEFAULT_CAPABILITIES = ['shell', 'fs']
/** 信任好友能有的能力（trustedPermits 的 key）。 */
export const TRUSTED_CAPABILITIES = ['shell', 'fs']

function qqOf(value) {
  return String(value ?? '').replace(/\D/g, '')
}

function capsOf(value) {
  const raw = Array.isArray(value?.capabilities)
    ? value.capabilities
    : Array.isArray(value)
      ? value
      : []
  const caps = [...new Set(raw.map((c) => String(c || '').trim().toLowerCase()))]
    .filter((c) => TRUSTED_CAPABILITIES.includes(c))
  return caps.length ? caps : [...TRUSTED_DEFAULT_CAPABILITIES]
}

/**
 * 把名单归一化成 Map<QQ 号, { qq, name, capabilities, addedBy, addedAt, source }>。
 * 接受三种写法：QQ 号数组、QQ 号 -> 能力表、QQ 号 -> { capabilities, name, ... }，
 * 外面再包一层 { friends: ... } / { version, friends } 也行。
 */
export function normalizeTrustedFriends(raw, source = 'file') {
  const out = new Map()
  const add = (qqValue, entry) => {
    const qq = qqOf(qqValue)
    if (!qq) return
    const isObj = entry && typeof entry === 'object' && !Array.isArray(entry)
    out.set(qq, {
      qq,
      name: isObj && typeof entry.name === 'string' ? entry.name : '',
      capabilities: entry == null ? [...TRUSTED_DEFAULT_CAPABILITIES] : capsOf(entry),
      addedBy: isObj && typeof entry.addedBy === 'string' ? entry.addedBy : '',
      addedAt: isObj && typeof entry.addedAt === 'string' ? entry.addedAt : '',
      source,
    })
  }
  const walk = (value) => {
    if (!value) return
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string' || typeof item === 'number') add(item, null)
        else if (item && typeof item === 'object' && item.qq != null) add(item.qq, item)
      }
      return
    }
    if (typeof value === 'object') {
      if (value.friends) { walk(value.friends); return }
      for (const [qq, entry] of Object.entries(value)) {
        if (qqOf(qq)) add(qq, entry)
      }
    }
  }
  walk(raw)
  return out
}

/** 只读名单文件（不存在或损坏时返回空名单，不抛错）。 */
export function readTrustedFriendsFile() {
  return normalizeTrustedFriends(readJson(dataDir(TRUSTED_FRIENDS_FILE), null), 'file')
}

/**
 * 名单全集：文件为主，面板配置 trustedFriends 为辅（没在文件里的才补上）。
 * 每次调用都重新读文件，改完下一条消息就生效。
 */
export function readTrustedFriends(cfg) {
  const out = readTrustedFriendsFile()
  for (const [qq, entry] of normalizeTrustedFriends(cfg?.trustedFriends, 'panel')) {
    if (!out.has(qq)) out.set(qq, entry)
  }
  return out
}

export function isTrustedFriend(cfg, userId) {
  const qq = qqOf(userId)
  return Boolean(qq) && readTrustedFriends(cfg).has(qq)
}

/** chatId 形如 private:<QQ>；只有私聊里、且 QQ 号在名单里、且不是主人，才算信任会话。 */
export function isTrustedChatId(cfg, chatId) {
  const m = /^private:(.+)$/.exec(String(chatId || ''))
  if (!m) return false
  const qq = qqOf(m[1])
  if (!qq || qq === qqOf(cfg?.ownerQQ)) return false
  return isTrustedFriend(cfg, qq)
}

/** 这个私聊会话里的信任好友有哪些能力（不是信任会话返回空数组）。 */
export function trustedCapabilities(cfg, chat) {
  if (!chat || chat.kind !== 'private') return []
  const entry = readTrustedFriends(cfg).get(qqOf(chat.userId))
  return entry ? [...entry.capabilities] : []
}

export function listTrustedFriends(cfg) {
  return [...readTrustedFriends(cfg).values()].sort((a, b) => a.qq.localeCompare(b.qq))
}

export function trustedFriendsFilePath() {
  return dataDir(TRUSTED_FRIENDS_FILE)
}

function readFileDoc() {
  const doc = { version: 1, friends: {} }
  for (const entry of readTrustedFriendsFile().values()) {
    doc.friends[entry.qq] = {
      name: entry.name,
      capabilities: entry.capabilities,
      addedBy: entry.addedBy,
      addedAt: entry.addedAt,
    }
  }
  return doc
}

function appendAudit(line) {
  try {
    const file = dataDir(TRUSTED_FRIENDS_LOG)
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, `${JSON.stringify(line)}\n`, 'utf8')
  } catch { /* 审计日志写不进去不影响名单本身 */ }
}

/**
 * 加人进名单（只能由主人在主人私聊里调用，调用方自己负责验身份）。
 * 返回 { ok, existed, entry, message }；QQ 号不对时 ok 为 false。
 */
export function addTrustedFriend({ qq, name = '', capabilities, by = '' }) {
  const id = qqOf(qq)
  if (!id || id.length < 5 || id.length > 15) {
    return { ok: false, message: `QQ 号 ${String(qq ?? '')} 不对：要 5 到 15 位数字` }
  }
  const caps = capabilities == null ? [...TRUSTED_DEFAULT_CAPABILITIES] : capsOf(capabilities)
  const doc = readFileDoc()
  const existed = Boolean(doc.friends[id])
  const now = new Date().toISOString()
  const prev = doc.friends[id] || {}
  doc.friends[id] = {
    qq: id,
    name: String(name || prev.name || '').slice(0, 40),
    capabilities: caps,
    addedBy: prev.addedBy || String(by || ''),
    addedAt: prev.addedAt || now,
    updatedAt: now,
    updatedBy: String(by || ''),
  }
  doc.updatedAt = now
  doc.updatedBy = String(by || '')
  writeJson(dataDir(TRUSTED_FRIENDS_FILE), doc)
  appendAudit({ ts: now, action: 'add', qq: id, name: doc.friends[id].name, capabilities: caps, by: String(by || '') })
  return { ok: true, existed, entry: doc.friends[id] }
}

/** 删人出名单（只能由主人在主人私聊里调用）。 */
export function removeTrustedFriend({ qq, by = '' }) {
  const id = qqOf(qq)
  if (!id) return { ok: false, existed: false, message: `QQ 号 ${String(qq ?? '')} 不对` }
  const doc = readFileDoc()
  const prev = doc.friends[id]
  if (!prev) return { ok: false, existed: false, message: `QQ 号 ${id} 本来就不在信任名单里` }
  delete doc.friends[id]
  const now = new Date().toISOString()
  doc.updatedAt = now
  doc.updatedBy = String(by || '')
  writeJson(dataDir(TRUSTED_FRIENDS_FILE), doc)
  appendAudit({ ts: now, action: 'remove', qq: id, name: prev.name || '', capabilities: prev.capabilities || [], by: String(by || '') })
  return { ok: true, existed: true, entry: { ...prev, qq: id } }
}
