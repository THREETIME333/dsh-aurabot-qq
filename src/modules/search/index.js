// 内置模块：联网搜索。只读取 DuckDuckGo 的公开搜索结果页，不打开搜索结果链接。

import { defineTool, str } from '../../tools/tools.js'
import { fetchGuarded } from '../../core/net.js'

const ENDPOINT = 'https://lite.duckduckgo.com/lite/'
const MAX_QUERY_CHARS = 200
const MAX_HTML_BYTES = 1_000_000
const RESULT_COUNT = 5

function decodeHtml(value) {
  return String(value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/\s+/g, ' ')
    .trim()
}

function resultUrl(raw) {
  try {
    const normalized = String(raw || '').replace(/&amp;/gi, '&')
    let url = new URL(normalized.startsWith('//') ? `https:${normalized}` : normalized, ENDPOINT)
    if (url.hostname === 'duckduckgo.com' && url.pathname === '/l/') {
      const target = url.searchParams.get('uddg')
      if (!target) return ''
      url = new URL(target)
    }
    if (!['http:', 'https:'].includes(url.protocol)) return ''
    return url.href
  } catch {
    return ''
  }
}

function looksSuspicious(url, title, snippet) {
  const text = `${url} ${title} ${snippet}`.toLowerCase()
  return /(?:^|[./_-])(?:crack|warez|keygen|破解版|破解|盗版|破解补丁)(?:$|[./_-])/.test(text)
    || /(?:\.exe|\.apk|\.msi|\.scr|\.bat|\.cmd|\.zip|\.rar)(?:[?#]|$)/i.test(url)
    || /(?:免费下载器|高速下载|安装下载器|付费解锁|立即充值)/.test(text)
}

function parseResults(html) {
  const source = String(html)
  const anchors = [...source.matchAll(/<a\b([^>]*\bclass\s*=\s*(['"])[^'"]*\bresult-link\b[^'"]*\2[^>]*)>([\s\S]*?)<\/a>/gi)]
  const results = []
  for (let i = 0; i < anchors.length && results.length < RESULT_COUNT; i++) {
    const match = anchors[i]
    const href = match[1].match(/\bhref\s*=\s*(['"])(.*?)\1/i)?.[2]?.replace(/&amp;/gi, '&')
    const url = resultUrl(href || '')
    const title = decodeHtml(match[3])
    if (!url || !title) continue
    const start = match.index + match[0].length
    const end = anchors[i + 1]?.index ?? Math.min(String(html).length, start + 5000)
    const following = source.slice(start, end)
    const snippetHtml = following.match(/<[^>]*class\s*=\s*(['"])[^'"]*\bresult-snippet\b[^'"]*\1[^>]*>([\s\S]*?)<\/td>/i)?.[2] || ''
    const snippet = decodeHtml(snippetHtml).slice(0, 240) || '（没有摘要）'
    results.push({ title: title.slice(0, 180), url, snippet, suspicious: looksSuspicious(url, title, snippet) })
  }
  return results
}

async function readLimited(response, maxBytes) {
  const reader = response.body?.getReader()
  if (!reader) return ''
  const chunks = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      throw new Error('搜索返回内容过大')
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function search(query) {
  const url = new URL(ENDPOINT)
  url.searchParams.set('q', query)
  const response = await fetchGuarded(url.href, { timeoutMs: 8000 })
  if (!response.ok) throw new Error(`搜索服务返回 HTTP ${response.status}`)
  const html = await readLimited(response, MAX_HTML_BYTES)
  return parseResults(html)
}

export default {
  id: 'search',
  name: '联网搜索',
  version: '1.0.0',
  description: '通过 DuckDuckGo 公开搜索页查找网页标题、链接和摘要；只搜索，不打开结果页面',
  setup(api) {
    api.tool(({ chat }) => (chat.kind !== 'system' ? defineTool({
      name: 'web_search',
      description: '联网查资料、查概念、找公开资源时使用。输入具体关键词；找影视或其他资源时优先找官方、合法且免费的观看/获取渠道。只返回搜索摘要，不访问结果页面。',
      properties: { query: str('要搜索的关键词或问题，最多 200 字') },
      required: ['query'],
      execute: async ({ query }) => {
        const q = String(query || '').trim().slice(0, MAX_QUERY_CHARS)
        if (!q) return { ok: false, message: '查询词是空的，请给我一个要查的内容。' }
        try {
          const results = await search(q)
          if (!results.length) return { ok: false, message: `没查到「${q}」的结果。可以换几个关键词再试。` }
          const lines = results.map((item, index) => `${index + 1}. ${item.title}${item.suspicious ? ' [链接可能涉及下载或付费，请谨慎]' : ''}\n${item.url}\n${item.snippet}`)
          return { ok: true, message: `「${q}」的搜索结果（来自 DuckDuckGo；摘要仅供参考）：\n${lines.join('\n')}` }
        } catch (error) {
          const timeout = error?.name === 'TimeoutError' || error?.name === 'AbortError'
          return { ok: false, message: timeout ? '搜索超时了，暂时没查到；过一会儿可以再试。' : `现在网络不通或搜索服务不可用，没查到结果（${String(error?.message || error).slice(0, 120)}）。` }
        }
      },
    }) : []))
    api.rule(() => '你可以用 web_search 联网查资料、查概念和找公开资源。需要最新或不确定的信息时先搜索；只根据工具返回的标题、链接和摘要回答，搜不到就直接说明没查到，不要编造。资源优先找官方、合法、免费的渠道。')
  },
}
