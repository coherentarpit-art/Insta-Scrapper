/**
 * Optional Instaloader (Python) integration — same JSON shape as ig-request feed nodes.
 * Enable with USE_INSTALOADER=1 and install: pip install instaloader
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

/** Instaloader prints a single JSON object (last line wins if something else is noisy). */
function parseJsonLineFromStdout(out) {
  const line = out.trim().split('\n').filter(Boolean).pop();
  if (!line) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/**
 * @returns {Promise<
 *   { profile: object, items: object[] } |
 *   { failed: true, error: string } |
 *   null
 * >}
 * - Success: { profile, items } (no `failed` key)
 * - Instaloader ran but failed: { failed: true, error } (include Python + stderr where useful)
 * - null: USE_INSTALOADER is off
 */
function fetchInstaloaderProfileAndPosts(username, maxPosts) {
  if (!isInstaloaderEnabled()) return Promise.resolve(null);

  const scriptPath = path.join(__dirname, 'instaloader_profile.py');
  const { cmd, args } = pythonCommand(scriptPath, username, maxPosts);

  return new Promise((resolve) => {
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timeoutMs = parseInt(process.env.INSTALOADER_TIMEOUT_MS || '120000', 10);
    let killedByTimeout = false;
    /** @type {import('child_process').ChildProcess | undefined} */
    let child;
    const timer = setTimeout(() => {
      killedByTimeout = true;
      try {
        if (child) child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
    }, timeoutMs);

    child = spawn(cmd, args, {
      cwd: path.join(__dirname),
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
      windowsHide: true,
    });

    let out = '';
    let stderrBuf = '';

    child.stdout.on('data', (d) => {
      out += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderrBuf += d.toString();
    });

    const failMessage = (code) => {
      const j = parseJsonLineFromStdout(out);
      const fromPython = j && (j.error || (j.ok === false && (j.error || 'Instaloader returned ok:false')));
      if (j && j.ok && j.profile) {
        return done({ profile: j.profile, items: Array.isArray(j.items) ? j.items : [] });
      }
      const parts = [];
      if (killedByTimeout) {
        parts.push(`Timed out after ${Math.round(timeoutMs / 1000)}s (increase INSTALOADER_TIMEOUT_MS in backend/.env if needed).`);
      }
      if (fromPython) {
        parts.push(String(fromPython));
      }
      const stderrHint = stderrBuf.trim().replace(/\r/g, ' ');
      if (stderrHint && !killedByTimeout) {
        const short = stderrHint.length > 400 ? `${stderrHint.slice(0, 400)}…` : stderrHint;
        parts.push(short);
      }
      if (!fromPython && !killedByTimeout) {
        if (code != null && code !== 0) {
          parts.push(
            `Python exited with code ${code}. If you see "instaloader not installed", run: pip install instaloader`
          );
        } else if (code === 0 && out.trim()) {
          parts.push('Invalid JSON on stdout — check instaloader_profile.py output');
        } else {
          parts.push('Instaloader produced no data. In backend/.env set USE_INSTALOADER=1 and either INSTALOADER_SESSION_FILE+INSTALOADER_SESSION_USER, or INSTALOADER_USER+INSTALOADER_PASSWORD.');
        }
      }
      const error = parts.filter(Boolean).join(' — ');
      return done({ failed: true, error: error || 'Instaloader failed' });
    };

    child.on('error', (e) => {
      const hint =
        e && e.code === 'ENOENT'
          ? `Cannot run "${cmd}". Install Python, add to PATH, or set PYTHON in backend/.env to python.exe.`
          : (e && e.message) || 'Failed to start Python process';
      done({ failed: true, error: hint });
    });

    child.on('close', (code) => {
      failMessage(code);
    });
  });
}

module.exports = {
  isInstaloaderEnabled,
  fetchInstaloaderProfileAndPosts,
};
