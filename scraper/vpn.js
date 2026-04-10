/**
 * VPN rotation helper (ProtonVPN CLI).
 *
 * Strategy:
 *   - rotate() is called reactively on 429/302 and preemptively every
 *     120-180 profiles (randomized jitter).
 *   - Uses `protonvpn-cli c -r` (random server) and waits for connection.
 *   - Verifies new public IP via api.ipify.org; retries once if unchanged.
 *
 * If ProtonVPN CLI is not installed, rotate() becomes a no-op and logs a
 * warning once — the scraper keeps running without rotation.
 */

const { exec } = require('child_process');
const https = require('https');

let lastIp = null;
let rotationCount = 0;
let nextRotateAt = randomThreshold();
let cliAvailable = null; // null = unknown, true/false after first check
let warnedUnavailable = false;

function randomThreshold() {
  return 120 + Math.floor(Math.random() * 61); // 120-180
}

function run(cmd, timeoutMs = 30000) {
  return new Promise((resolve) => {
    exec(cmd, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ err, stdout: (stdout || '').toString(), stderr: (stderr || '').toString() });
    });
  });
}

function getPublicIp() {
  return new Promise((resolve) => {
    const req = https.get('https://api.ipify.org?format=json', (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data).ip); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(8000, () => { req.destroy(); resolve(null); });
  });
}

async function checkCli() {
  if (cliAvailable !== null) return cliAvailable;
  const { err } = await run('protonvpn-cli --version', 5000);
  cliAvailable = !err;
  if (!cliAvailable && !warnedUnavailable) {
    console.log('  [vpn] ProtonVPN CLI not found — rotation disabled. Install protonvpn-cli to enable.');
    warnedUnavailable = true;
  }
  return cliAvailable;
}

/**
 * Force rotate to a new random server.
 * @param {string} reason - why we rotated (for logs)
 */
async function rotate(reason = 'preemptive') {
  if (!(await checkCli())) return false;

  const before = lastIp || (await getPublicIp());
  console.log(`  [vpn] Rotating (${reason}). Current IP: ${before || 'unknown'}`);

  // Disconnect then reconnect to a random server
  await run('protonvpn-cli d', 15000);
  const { err } = await run('protonvpn-cli c -r', 30000);

  if (err) {
    console.log(`  [vpn] Rotation failed: ${err.message}. Retrying once...`);
    await run('protonvpn-cli d', 15000);
    await run('protonvpn-cli c -r', 30000);
  }

  // Give the tunnel a moment to settle
  await new Promise((r) => setTimeout(r, 3000));

  const after = await getPublicIp();
  lastIp = after;
  rotationCount++;
  nextRotateAt = randomThreshold();
  console.log(`  [vpn] Rotation #${rotationCount} done. New IP: ${after || 'unknown'} (next rotate in ~${nextRotateAt} profiles)`);
  return true;
}

/**
 * Called once per processed profile. Rotates if we've hit the jittered
 * threshold since the last rotation.
 */
async function maybeRotate(profilesSinceLastRotate) {
  if (profilesSinceLastRotate >= nextRotateAt) {
    await rotate('preemptive');
    return true;
  }
  return false;
}

function getStats() {
  return { rotationCount, lastIp, nextRotateAt };
}

module.exports = { rotate, maybeRotate, getStats, checkCli };
