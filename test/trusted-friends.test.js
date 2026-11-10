// 信任好友名单：归一化、文件读写、审计日志。
// 名单存在临时目录里（AURABOT_DATA_DIR），不碰开发机上的真实名单。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  addTrustedFriend,
  isTrustedChatId,
  isTrustedFriend,
  listTrustedFriends,
  normalizeTrustedFriends,
  removeTrustedFriend,
  trustedCapabilities,
  trustedFriendsFilePath,
  TRUSTED_FRIENDS_LOG,
} from '../src/chat/trusted-friends.js'
import { levelFor } from '../src/chat/access.js'
import { dataDir } from '../src/core/store.js'

const dir = mkdtempSync(join(tmpdir(), 'aurabot-trusted-'))
process.env.AURABOT_DATA_DIR = dir
const ownerQQ = '10000001'
const cfg = { ownerQQ, ownerLevel: 'full' }
const friend = '20002'

test('归一化：QQ 号数组、QQ 号→能力表、QQ 号→详情、{friends} 外包都能读', () => {
  const a = normalizeTrustedFriends([friend])
  assert.equal(a.get(friend).qq, friend)
  assert.deepEqual(a.get(friend).capabilities, ['shell', 'fs'])
  const b = normalizeTrustedFriends({ [friend]: ['shell'] })
  assert.deepEqual(b.get(friend).capabilities, ['shell'])
  const c = normalizeTrustedFriends({ [friend]: { capabilities: ['fs'], name: '小明' } })
  assert.deepEqual(c.get(friend).capabilities, ['fs'])
  assert.equal(c.get(friend).name, '小明')
  const d = normalizeTrustedFriends({ friends: { [friend]: ['shell'] } })
  assert.deepEqual(d.get(friend).capabilities, ['shell'])
  // 能力只留 shell/fs，空能力回到默认
  assert.deepEqual(normalizeTrustedFriends({ [friend]: ['web', 'jobs'] }).get(friend).capabilities, ['shell', 'fs'])
  // 不是 QQ 号的键不要
  assert.equal(normalizeTrustedFriends(['abc']).size, 0)
})

test('名单来源：文件和面板配置并在一起', () => {
  addTrustedFriend({ qq: friend, by: ownerQQ })
  const panelCfg = { ...cfg, trustedFriends: ['30003'] }
  assert.equal(isTrustedFriend(panelCfg, friend), true)
  assert.equal(isTrustedFriend(panelCfg, '30003'), true)
  assert.equal(isTrustedFriend(panelCfg, '99999'), false)
})

test('只在私聊里生效，主人不算信任好友', () => {
  const c = { ...cfg, trustedFriends: [friend] }
  assert.equal(isTrustedChatId(c, `private:${friend}`), true)
  assert.equal(isTrustedChatId(c, `group:${friend}`), false)
  assert.equal(isTrustedChatId(c, 'private:999'), false)
  // 主人就算写进名单，私聊档位也还是 full
  const c2 = { ...cfg, trustedFriends: [friend, ownerQQ] }
  assert.equal(isTrustedChatId(c2, `private:${ownerQQ}`), false)
  assert.equal(levelFor(c2, { kind: 'private', userId: ownerQQ }), 'full')
})

test('加人/删人写文件、记审计日志，写完立刻能读到', () => {
  const logPath = dataDir(TRUSTED_FRIENDS_LOG)
  const added = addTrustedFriend({ qq: '40004', name: '小明', by: ownerQQ })
  assert.equal(added.ok, true)
  assert.equal(added.existed, false)
  assert.equal(added.entry.qq, '40004')
  assert.equal(added.entry.name, '小明')
  assert.deepEqual(added.entry.capabilities, ['shell', 'fs'])
  assert.equal(existsSync(trustedFriendsFilePath()), true)
  const again = addTrustedFriend({ qq: '40004', by: ownerQQ })
  assert.equal(again.ok, true)
  assert.equal(again.existed, true)
  assert.equal(isTrustedFriend(cfg, '40004'), true)
  assert.equal(listTrustedFriends(cfg).some((f) => f.qq === '40004'), true)
  assert.deepEqual(trustedCapabilities(cfg, { kind: 'private', userId: '40004' }), ['shell', 'fs'])
  assert.deepEqual(trustedCapabilities(cfg, { kind: 'group', userId: '40004' }), [])
  const lines = readFileSync(logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  const adds = lines.filter((l) => l.action === 'add' && l.qq === '40004')
  assert.ok(adds.length >= 1)
  assert.equal(adds[0].by, ownerQQ)
  const removed = removeTrustedFriend({ qq: '40004', by: ownerQQ })
  assert.equal(removed.ok, true)
  assert.equal(removed.existed, true)
  assert.equal(isTrustedFriend(cfg, '40004'), false)
  const lines2 = readFileSync(logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(lines2.some((l) => l.action === 'remove' && l.qq === '40004' && l.by === ownerQQ), true)
})

test('删不存在的返回不通过，无效 QQ 号加不进去', () => {
  const missing = removeTrustedFriend({ qq: '40004', by: ownerQQ })
  assert.equal(missing.ok, false)
  assert.equal(missing.existed, false)
  assert.equal(addTrustedFriend({ qq: 'abc', by: ownerQQ }).ok, false)
  assert.equal(addTrustedFriend({ qq: '123', by: ownerQQ }).ok, false)
})
