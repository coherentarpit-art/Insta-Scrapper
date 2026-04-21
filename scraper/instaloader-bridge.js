/**
 * Optional Instaloader (Python) integration — same JSON shape as ig-request feed nodes.
 * Enable with USE_INSTALOADER=1 and install: pip install -r requirements-instaloader.txt
 */

const path = require('path');
const { spawn } = require('child_process');

function isInstaloaderEnabled() {
  const v = String(process.env.USE_INSTALOADER || '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

function pythonCommand(scriptPath, username, maxPosts) {
  const extraArgs = [scriptPath, username, String(maxPosts)];
  const explicit = process.env.PYTHON || process.env.PYTHON3;
  if (explicit) {
    return { cmd: explicit, args: extraArgs };
  }
  if (process.platform === 'win32') {
    return { cmd: 'python', args: extraArgs };
  }
  return { cmd: 'python3', args: extraArgs };
}

/**
 * @returns {Promise<{ profile: object, items: object[] } | null>}
 */
function fetchInstaloaderProfileAndPosts(username, maxPosts) {
  if (!isInstaloaderEnabled()) return Promise.resolve(null);

  const scriptPath = path.join(__dirname, 'instaloader_profile.py');
  const { cmd, args } = pythonCommand(scriptPath, username, maxPosts);

  return new Promise((resolve) => {
    const timeoutMs = parseInt(process.env.INSTALOADER_TIMEOUT_MS || '120000', 10);
    const child = spawn(cmd, args, {
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
      windowsHide: true,
    });

    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
    }, timeoutMs);

    child.stdout.on('data', (d) => {
      out += d.toString();
    });
    child.stderr.on('data', (d) => {
      err += d.toString();
    });

    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        resolve(null);
        return;
      }
      try {
        const line = out.trim().split('\n').filter(Boolean).pop();
        if (!line) {
          resolve(null);
          return;
        }
        const j = JSON.parse(line);
        if (!j.ok || !j.profile) {
          resolve(null);
          return;
        }
        resolve({ profile: j.profile, items: Array.isArray(j.items) ? j.items : [] });
      } catch {
        resolve(null);
      }
    });
  });
}

module.exports = {
  isInstaloaderEnabled,
  fetchInstaloaderProfileAndPosts,
};
