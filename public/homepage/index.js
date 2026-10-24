document.getElementById('year').textContent = new Date().getFullYear();

// ---------------------------------------------------------------------
// Live API status: one real request to the server, timed in the browser.
// ---------------------------------------------------------------------
const status = document.getElementById('status');
const statusText = document.getElementById('status-text');

async function checkStatus() {
    const t0 = performance.now();
    try {
        const res = await fetch('/api/v1/cropguard/health', { cache: 'no-store' });
        if (!res.ok) throw new Error(String(res.status));
        const ms = Math.round(performance.now() - t0);
        status.classList.add('up');
        statusText.textContent = `API online · answered in ${ms} ms`;
    } catch {
        status.classList.add('down');
        statusText.textContent = 'API is waking up, try again in a minute';
    }
}
checkStatus();

// ---------------------------------------------------------------------
// Accounts live in the developer portal (/developers/). If its token
// (localStorage "fb_dev_token") is still valid, swap Sign in / Get started
// for a chip that opens the dashboard - re-verified against the API on
// every load, so an expired token falls back to signed-out.
// ---------------------------------------------------------------------
const logins = document.querySelector('.logins');
const TOKEN_KEY = 'fb_dev_token';
const readToken = () => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } };
const clearToken = () => { try { localStorage.removeItem(TOKEN_KEY); } catch { /* private mode */ } };
const signedOutHtml = logins ? logins.innerHTML : '';

function renderLoggedOut() {
    if (logins) logins.innerHTML = signedOutHtml;
}

function renderLoggedIn(dev) {
    if (!logins) return;
    const label = dev.name || dev.email || 'Account';
    logins.innerHTML = '';

    const row = document.createElement('div');
    row.className = 'account';

    const link = document.createElement('a');
    link.href = '/developers/#/apps';
    link.className = 'account-link';
    const avatar = document.createElement('span');
    avatar.className = 'account-avatar';
    avatar.textContent = label.charAt(0).toUpperCase();
    const name = document.createElement('span');
    name.className = 'account-name';
    name.textContent = label;
    link.append(avatar, name);

    const out = document.createElement('button');
    out.type = 'button';
    out.className = 'btn btn-ghost btn-sm';
    out.textContent = 'Sign out';
    out.addEventListener('click', () => {
        clearToken();
        renderLoggedOut();
    });

    row.append(link, out);
    logins.append(row);
}

async function checkAuth() {
    const token = readToken();
    if (!token) return;
    try {
        const res = await fetch('/api/v1/platform/auth/me', { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) throw new Error('Session is no longer valid');
        renderLoggedIn(await res.json());
    } catch {
        clearToken();
        renderLoggedOut();
    }
}
checkAuth();
