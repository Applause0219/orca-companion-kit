// Safe fetching of user-supplied links: http/https only, no private/loopback/link-local targets (checked on
// the first request and on every redirect), size and time limits.
import dns from 'node:dns/promises'
import net from 'node:net'

export class BlockedError extends Error {}

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
    if (s === '::' || s === '::1') return true
    const mapped = /^(?:0:0:0:0:0:ffff:|::ffff:)(.+)$/.exec(s)
    if (mapped) {
      const rest = mapped[1]
      if (net.isIPv4(rest)) return isPrivateIp(rest)
      const h = rest.split(':').map((x) => parseInt(x, 16))
      if (h.length === 2 && h.every(Number.isFinite)) return isPrivateIp(`${h[0] >> 8}.${h[0] & 255}.${h[1] >> 8}.${h[1] & 255}`)
      return true
    }
    const first = parseInt(s.split(':')[0] || '0', 16)
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00 || s.startsWith('64:ff9b:')
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
