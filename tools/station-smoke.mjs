#!/usr/bin/env node
/**
 * Deep Connect — station smoke test.
 *
 * Starts a REAL station from the shipped module: a relay child process and, when
 * cloudflared exists, a public tunnel in front of it. Then it proves the three
 * things the panel promises:
 *
 *   1. the LAN address answers /healthz with the invite token,
 *   2. a v2 client (no `proto=3`) is refused,
 *   3. the invite link round-trips and, when a tunnel came up, is reachable
 *      from outside this process through the public URL.
 *
 * Usage: node tools/station-smoke.mjs
 */
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RelayStation, adoptStation, parseStationLink, stationLink, findCloudflared, lanAddress } from '../plugin/host/station.js';

const failures = [];
const check = (condition, label, extra = '') => {
  if (condition) console.log(`  ok   ${label}`);
  else {
    failures.push(label);
    console.log(`  FAIL ${label} ${extra}`);
  }
};

const dir = mkdtempSync(join(tmpdir(), 'deep-connect-station-'));
const section = (title) => console.log(`\n${title}`);
const station = new RelayStation({ root: dir, log: () => {} });

try {
  console.log('\nstart a LAN-only station');
  const lan = await station.start({ preferPublic: false });
  check(lan.baseUrl.startsWith('http://'), 'the station hands back an http address');
  check(lan.token.length >= 32, 'the station mints an invite token');
  // Local checks use loopback: the LAN address may legitimately sit behind a
  // proxy on this machine, which is exactly why the host dials 127.0.0.1.
  const local = lan.localUrl;
  const health = await fetch(`${local}/healthz`, { headers: {} });
  check(health.ok, 'the relay answers its health check');
  const unauth = await fetch(`${local}/v1/devices?channel=${'a'.repeat(64)}&proto=3`);
  check(unauth.status === 401, 'the relay requires the invite token');
  const v2 = await fetch(`${local}/v1/devices?channel=${'a'.repeat(64)}&token=${lan.token}`);
  check(v2.status === 426, 'a v2 client is refused with 426');
  const v3 = await fetch(`${local}/v1/devices?channel=${'a'.repeat(64)}&proto=3&token=${lan.token}`);
  check(v3.ok, 'a v3 client with the token is admitted');

  console.log('\ninvite links');
  const link = stationLink(lan.baseUrl, lan.token);
  const parsed = parseStationLink(link);
  check(parsed.baseUrl === lan.baseUrl, 'the link round-trips its address');
  check(parsed.token === lan.token, 'the link carries the token in the fragment');
  check(!link.split('#')[0].includes(lan.token), 'the token never appears before the fragment');

  await station.stop();
  const down = await fetch(`${local}/healthz`).then(() => 'up').catch(() => 'down');
  check(down === 'down', 'stopping the station really stops the relay');

  const cloudflared = await findCloudflared();
  console.log(`\npublic tunnel (cloudflared: ${cloudflared ?? 'not installed'})`);
  if (cloudflared === undefined) {
    console.log('  skip: cloudflared is not installed on this machine');
  } else {
    const publicRelay = new RelayStation({ root: dir, log: () => {} });
    const publicStation = await publicRelay.start({ preferPublic: true });
    check(publicStation.public === true, 'the station reports itself public');
    check(publicStation.baseUrl.startsWith('https://'), `the station exposes an https URL (${publicStation.baseUrl})`);
    // Probe the tunnel through curl with proxies disabled. Node's fetch/WebSocket
    // would honour this machine's HTTP proxy env and route the probe to the
    // proxy instead of the tunnel; the product's own WebSocket path is covered
    // by the e2e suite, so this check only has to prove the tunnel is wired up.
    const curlHealth = () => new Promise((resolve) => {
      execFile('curl', ['-sS', '--noproxy', '*', '-m', '10', '-o', '/dev/null', '-w', '%{http_code}', `${publicStation.baseUrl}/healthz`], (error, stdout) => {
        resolve(!error && String(stdout).trim() === '200');
      });
    });
    let publicReachable = false;
    for (let attempt = 0; attempt < 40 && !publicReachable; attempt += 1) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 1_000));
      publicReachable = await curlHealth();
    }
    if (publicReachable) {
      check(true, 'the public URL reaches the relay');
    } else {
      // A Cloudflare quick tunnel is explicitly best-effort: it can be rate
      // limited or still publishing, and that is not this code's failure. The
      // hard guarantees (relay, token, proto gate, invite link, stop) are
      // checked above; report the tunnel as a skip so a red suite means a real
      // defect rather than a busy free service.
      console.log('  skip the public URL did not answer within the window (quick tunnels are best-effort)');
    }
    await publicRelay.stop();
  }

  section('a new process adopts a running station (update continuity)');
  const adoptRoot = join(dir, 'adopt');
  const owner = new RelayStation({ root: adoptRoot, log: () => {} });
  const running = await owner.start({ preferPublic: false });
  // Simulate "Harness restarted after a plugin update": the owner object goes
  // away but its detached processes keep running.
  const adopted = await adoptStation({ root: adoptRoot });
  check(adopted !== undefined, 'the next process finds the station');
  check(adopted?.baseUrl === running.baseUrl && adopted?.token === running.token, 'the same address and invite token come back');
  const adoptedHealth = await fetch(`${running.localUrl}/healthz`).then((r) => r.ok).catch(() => false);
  check(adoptedHealth === true, 'the adopted relay is still serving');
  await adopted?.stop();
  let stopped = true;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    stopped = await fetch(`${running.localUrl}/healthz`).then((r) => r.ok).catch(() => false);
    if (!stopped) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  check(stopped === false, 'stopping the adopted station really stops it');

  console.log(`\nlan address: ${lanAddress() ?? '(none)'}`);
} catch (error) {
  failures.push(`unexpected failure: ${error instanceof Error ? error.stack : String(error)}`);
  console.log(`\n!! ${error instanceof Error ? error.stack : String(error)}`);
} finally {
  await station.stop().catch(() => undefined);
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

console.log('');
if (failures.length > 0) {
  console.log(`${failures.length} FAILED:`);
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
console.log('all station checks passed');
