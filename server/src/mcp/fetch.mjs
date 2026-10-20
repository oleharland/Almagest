/**
 * fetch.mjs — the only outbound HTTP request a chat can cause, guarded.
 *
 * `submit_source { url }` lets whoever holds a token make this server issue a
 * GET. Unguarded, that is a server-side request forgery primitive: the cloud
 * metadata endpoint, the database on the private network, the admin port on
 * localhost. So, all of these, every hop:
 *
 *   - http and https only, no credentials in the URL
 *   - the host is resolved here, every resolved address is checked against
 *     the private / loopback / link-local / metadata / reserved ranges, and
 *     the socket connects to the address that was checked (custom `lookup`),
 *     so a DNS answer cannot change between the check and the connect
 *   - redirects are followed by hand, at most `maxRedirects`, each one
 *     re-checked from the top
 *   - a byte cap and a wall-clock cap on the whole exchange
 *
 * Off unless `mcp.allow_url_fetch: true`.
 */
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

export class FetchBlockedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FetchBlockedError';
  }
}

const BLOCKED = new net.BlockList();
for (const [addr, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) BLOCKED.addSubnet(addr, prefix, 'ipv4');
for (const [addr, prefix] of [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
  ['2001:db8::', 32], ['100::', 64], ['2001::', 23],
]) BLOCKED.addSubnet(addr, prefix, 'ipv6');

/** IPv4 embedded in an IPv6 address (mapped ::ffff:a.b.c.d, NAT64 64:ff9b::/96, compat ::a.b.c.d), or null. */
function embeddedV4(address) {
  const a = address.toLowerCase();
  const dotted = a.match(/^(?:::ffff:|64:ff9b::|::)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return dotted[1];
  const hex = a.match(/^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return null;
}

/** True when `address` (an IP literal) is somewhere a public fetch may go. */
export function isPublicAddress(address) {
  const family = net.isIP(address);
  if (!family) return false;
  if (family === 4) return !BLOCKED.check(address, 'ipv4');
  const v4 = embeddedV4(address);
  if (v4) return !BLOCKED.check(v4, 'ipv4');
  if (/^::ffff:/i.test(address) || /^64:ff9b::/i.test(address)) return false;
  return !BLOCKED.check(address, 'ipv6');
}

/** A `lookup` for http.request that refuses to hand back an address the policy blocks. */
function guardedLookup(isAllowed) {
  return (hostname, options, callback) => {
    dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err) return callback(err);
      const bad = addresses.find((a) => !isAllowed(a.address));
      if (bad || !addresses.length) {
        return callback(new FetchBlockedError(`refusing to fetch ${hostname}: resolves to a non-public address (${bad?.address || 'none'})`));
      }
      if (options?.all) return callback(null, addresses);
      return callback(null, addresses[0].address, addresses[0].family);
    });
  };
}

function checkUrl(raw, isAllowed) {
  let url;
  try { url = new URL(raw); } catch { throw new FetchBlockedError(`not a URL: ${raw}`); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new FetchBlockedError(`only http and https URLs can be fetched (got ${url.protocol})`);
  if (url.username || url.password) throw new FetchBlockedError('URLs with credentials are not fetched');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) && !isAllowed(host)) throw new FetchBlockedError(`refusing to fetch ${host}: not a public address`);
  if (/^localhost$|\.localhost$|\.local$|\.internal$/i.test(host)) throw new FetchBlockedError(`refusing to fetch ${host}: not a public host`);
  return url;
}

function requestOnce(url, { lookup, signal, maxBytes, headers }) {
  const mod = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(url, { method: 'GET', lookup, signal, headers, agent: false }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        return resolve({ status, location: res.headers.location });
      }
      const declared = Number(res.headers['content-length'] || 0);
      if (declared > maxBytes) {
        res.destroy();
        return reject(new FetchBlockedError(`response is ${declared} bytes — over the ${maxBytes}-byte cap`));
      }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > maxBytes) {
          res.destroy();
          reject(new FetchBlockedError(`response exceeded the ${maxBytes}-byte cap`));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => resolve({ status, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * @param {string} rawUrl
 * @param {object} [options]
 * @param {number} [options.maxBytes]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.maxRedirects]
 * @param {(ip: string) => boolean} [options.isAllowed]   address policy; tests narrow it, production never widens it
 * @returns {Promise<{ url: string, status: number, contentType: string, body: Buffer }>}
 */
export async function guardedFetch(rawUrl, options = {}) {
  const { maxBytes = 5 * 1024 * 1024, timeoutMs = 10_000, maxRedirects = 5, isAllowed = isPublicAddress } = options;
  const signal = AbortSignal.timeout(timeoutMs);
  const lookup = guardedLookup(isAllowed);
  let url = checkUrl(rawUrl, isAllowed);
  for (let hop = 0; ; hop++) {
    let res;
    try {
      res = await requestOnce(url, { lookup, signal, maxBytes, headers: { 'user-agent': 'almagest-mcp/0.2 (+submit_source)', accept: 'text/*, application/json, application/pdf, application/xml;q=0.9, */*;q=0.1' } });
    } catch (err) {
      if (err instanceof FetchBlockedError || err?.cause instanceof FetchBlockedError) throw err instanceof FetchBlockedError ? err : err.cause;
      if (err?.name === 'AbortError' || signal.aborted) throw new FetchBlockedError(`fetch timed out after ${timeoutMs} ms`);
      throw new Error(`fetch failed: ${err.message}`);
    }
    if (res.location) {
      if (hop >= maxRedirects) throw new FetchBlockedError(`more than ${maxRedirects} redirects`);
      url = checkUrl(new URL(res.location, url).href, isAllowed);
      continue;
    }
    if (res.status < 200 || res.status >= 300) throw new Error(`fetch failed: ${url.href} answered ${res.status}`);
    return { url: url.href, status: res.status, contentType: String(res.headers['content-type'] || ''), body: res.body };
  }
}
