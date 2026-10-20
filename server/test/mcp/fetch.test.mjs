import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';

import { guardedFetch, isPublicAddress } from '../../src/mcp/fetch.mjs';

describe('SSRF address policy', () => {
  it('blocks private, loopback, link-local, metadata and reserved ranges', () => {
    for (const ip of [
      '127.0.0.1', '127.8.8.8', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1',
      '0.0.0.0', '224.0.0.1', '255.255.255.255', '198.18.0.1', '::1', '::', 'fe80::1', 'fc00::1', 'fd00:ec2::254',
      '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:169.254.169.254', '64:ff9b::10.0.0.1', 'ff02::1', 'not-an-ip',
    ]) assert.equal(isPublicAddress(ip), false, ip);
  });

  it('allows public addresses', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111', '::ffff:8.8.8.8', '172.32.0.1']) {
      assert.equal(isPublicAddress(ip), true, ip);
    }
  });
});

describe('guardedFetch', () => {
  let server;
  let base;
  before(async () => {
    server = http.createServer((req, res) => {
      const port = server.address().port;
      if (req.url === '/ok') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('hello'); }
      if (req.url === '/to-v6') { res.writeHead(302, { location: `http://[::1]:${port}/ok` }); return res.end(); }
      if (req.url === '/to-file') { res.writeHead(302, { location: 'file:///etc/passwd' }); return res.end(); }
      if (req.url === '/to-self') { res.writeHead(302, { location: '/ok' }); return res.end(); }
      if (req.url.startsWith('/loop')) { res.writeHead(302, { location: `/loop${Math.random()}` }); return res.end(); }
      if (req.url === '/big') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('x'.repeat(5000)); }
      if (req.url === '/slow') { setTimeout(() => res.end('late'), 2000); return undefined; }
      res.writeHead(404); return res.end();
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server.close());

  // The test server lives on 127.0.0.1; treat exactly that address as "public" for these tests.
  const onlyLoopbackV4 = (ip) => ip === '127.0.0.1';

  it('blocks loopback under the real policy', async () => {
    await assert.rejects(() => guardedFetch(`${base}/ok`), /refusing/);
  });

  it('fetches under a policy that allows the address', async () => {
    const r = await guardedFetch(`${base}/ok`, { isAllowed: onlyLoopbackV4 });
    assert.equal(r.body.toString(), 'hello');
    assert.match(r.contentType, /text\/plain/);
  });

  it('re-checks every redirect hop', async () => {
    assert.equal((await guardedFetch(`${base}/to-self`, { isAllowed: onlyLoopbackV4 })).body.toString(), 'hello');
    await assert.rejects(() => guardedFetch(`${base}/to-v6`, { isAllowed: onlyLoopbackV4 }), /not a public address/);
    await assert.rejects(() => guardedFetch(`${base}/to-file`, { isAllowed: onlyLoopbackV4 }), /only http and https/);
    await assert.rejects(() => guardedFetch(`${base}/loop`, { isAllowed: onlyLoopbackV4, maxRedirects: 3 }), /more than 3 redirects/);
  });

  it('caps size and time', async () => {
    await assert.rejects(() => guardedFetch(`${base}/big`, { isAllowed: onlyLoopbackV4, maxBytes: 1000 }), /cap/);
    await assert.rejects(() => guardedFetch(`${base}/slow`, { isAllowed: onlyLoopbackV4, timeoutMs: 200 }), /timed out/);
  });

  it('refuses non-http schemes, credentials and internal names before any request', async () => {
    await assert.rejects(() => guardedFetch('ftp://example.com/x'), /only http and https/);
    await assert.rejects(() => guardedFetch('https://user:pw@example.com/'), /credentials/);
    await assert.rejects(() => guardedFetch('http://metadata.google.internal/'), /not a public host/);
    await assert.rejects(() => guardedFetch('http://[fd00:ec2::254]/'), /not a public address/);
  });
});
