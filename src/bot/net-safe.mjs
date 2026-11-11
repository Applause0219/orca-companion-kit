// Safe fetching of user-supplied links: http/https only, no private/loopback/link-local targets (checked on
// the first request and on every redirect), size and time limits.
import dns from 'node:dns/promises'
import net from 'node:net'

export class BlockedError extends Error {}

/** An IPv6 literal as 8 numbers (handles :: and a trailing dotted IPv4), or null. */
function v6groups(s) {
  let t = s
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(t)
  if (dotted) {
    const p = dotted[1].split('.').map(Number)
    if (!net.isIPv4(dotted[1])) return null
    t = t.slice(0, -dotted[1].length) + ((p[0] << 8) | p[1]).toString(16) + ':' + ((p[2] << 8) | p[3]).toString(16)
  }
  const [head, tail, extra] = t.split('::')
  if (extra !== undefined) return null
  const a = head ? head.split(':') : []
  const b = tail === undefined ? [] : tail ? tail.split(':') : []
  const fill = tail === undefined ? 0 : 8 - a.length - b.length
  if (fill < 0 || (tail === undefined && a.length !== 8)) return null
  const all = [...a, ...Array(fill).fill('0'), ...b].map((x) => parseInt(x, 16))
  return all.length === 8 && all.every((x) => Number.isInteger(x) && x >= 0 && x <= 0xffff) ? all : null
}

/** True for loopback, private, link-local, CGNAT, multicast, unspecified and reserved addresses (v4 and v6). */
export function isPrivateIp(ip) {
  const s = String(ip).toLowerCase().replace(/^\[|\]$/g, '').split('%')[0]
  if (net.isIPv4(s)) {
    const [a, b] = s.split('.').map(Number)
    return (
      a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224
    )
  }
  if (net.isIPv6(s)) {
    const g = v6groups(s)
    if (!g) return true
    const v4 = (a, b) => `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`
    if (g.slice(0, 7).every((x) => x === 0) && g[7] <= 1) return true // :: and ::1
    if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return isPrivateIp(v4(g[6], g[7])) // ::ffff:a.b.c.d
    if (g.slice(0, 4).every((x) => x === 0) && g[4] === 0xffff && g[5] === 0) return isPrivateIp(v4(g[6], g[7])) // ::ffff:0:a.b.c.d (SIIT translated form)
    if (g[0] === 0x100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true // 100::/64 discard-only
    if (g[0] === 0x2001 && g[1] === 0xdb8) return true // 2001:db8::/32 documentation
    if (g.slice(0, 6).every((x) => x === 0)) return true // IPv4-compatible ::a.b.c.d (deprecated)
    if (g[0] === 0x2002) return isPrivateIp(v4(g[1], g[2])) // 6to4: judge the embedded IPv4
    if (g[0] === 0x2001 && g[1] === 0) return true // Teredo 2001::/32
    if (g[0] === 0x64 && g[1] === 0xff9b) return true // NAT64
    return (g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xffc0) === 0xfec0 || (g[0] & 0xff00) === 0xff00 // fc00::/7, fe80::/10, fec0::/10, ff00::/8
  }
  return true // not an address at all: refuse
}

/** Throws BlockedError unless the URL is http(s) and every address its host resolves to is public. */
export async function assertPublicUrl(url, lookup = (h) => dns.lookup(h, { all: true })) {
  let u
  try {
    u = new URL(url)
  } catch {
    throw new BlockedError('not a valid URL')
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new BlockedError('only http and https links are read')
  if (u.username || u.password) throw new BlockedError('links with credentials are not read')
  const host = u.hostname.replace(/^\[|\]$/g, '')
  if (/^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i.test(host)) throw new BlockedError('local host name')
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new BlockedError('private address')
    return u
  }
  const addrs = await lookup(host)
  const list = Array.isArray(addrs) ? addrs : [addrs]
  if (!list.length) throw new BlockedError('host does not resolve')
  for (const a of list) if (isPrivateIp(a.address ?? a)) throw new BlockedError('host resolves to a private address')
  return u
}

/**
 * GET with manual redirects (max `redirects`), each hop checked by assertPublicUrl. Body read up to maxBytes
 * (stops reading, no error). -> { url (final), status, contentType, text, truncated }.
 * Note: DNS is resolved once for the check and again by fetch; this narrows but cannot fully close a DNS
 * rebinding window. Documented limit.
 */
export async function safeFetchText(url, { maxBytes = 1_500_000, timeoutMs = 15000, redirects = 5, headers = {}, fetchImpl = fetch, lookup } = {}) {
  let cur = url
  const signal = AbortSignal.timeout(timeoutMs)
  for (let hop = 0; hop <= redirects; hop++) {
    await assertPublicUrl(cur, lookup)
    const r = await fetchImpl(cur, { redirect: 'manual', signal, headers: { 'Accept-Language': 'en,zh;q=0.8', ...headers } })
    if ([301, 302, 303, 307, 308].includes(r.status)) {
      const loc = r.headers.get('location')
      try {
        await r.body?.cancel()
      } catch {}
      if (!loc) throw new Error('redirect without a location')
      cur = new URL(loc, cur).href
      continue
    }
    const contentType = r.headers.get('content-type') ?? ''
    if (/^(image|video|audio)\//i.test(contentType) || /application\/(zip|octet-stream|pdf)/i.test(contentType)) {
      try {
        await r.body?.cancel()
      } catch {}
      return { url: cur, status: r.status, contentType, text: '', truncated: false, skipped: 'not a text page' }
    }
    const chunks = []
    let size = 0
    let truncated = false
    if (r.body) {
      for await (const c of r.body) {
        size += c.length
        chunks.push(c)
        if (size >= maxBytes) {
          truncated = true
          try {
            await r.body.cancel()
          } catch {}
          break
        }
      }
    }
    const text = Buffer.concat(chunks.map((c) => Buffer.from(c))).subarray(0, maxBytes).toString('utf8')
    return { url: cur, status: r.status, contentType, text, truncated }
  }
  throw new Error('too many redirects')
}
