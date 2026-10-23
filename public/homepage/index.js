const navToggle = document.querySelector('.nav-toggle');
const navLinks = document.querySelector('.nav-links');
const logins = document.querySelector('.logins');

navToggle.addEventListener('click', () => {
    navLinks.classList.toggle('active');
    navToggle.classList.toggle('active');
    logins?.classList.toggle('active');
});

// ---------------------------------------------------------------------
// Accounts live in the developer portal (/developers/). If its token
// (localStorage "fb_dev_token") is still valid, swap Log in / Get started
// for a chip that opens the dashboard - re-verified against the API on
// every load, so an expired token falls back to logged-out.
// ---------------------------------------------------------------------

const TOKEN_KEY = 'fb_dev_token';
const readToken = () => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } };
const clearToken = () => { try { localStorage.removeItem(TOKEN_KEY); } catch { /* private mode */ } };

function renderLoggedOut() {
    if (!logins) return;
    logins.innerHTML = '';

    const loginLink = document.createElement('a');
    loginLink.href = '/developers/#/signin';
    loginLink.textContent = 'Log in';

    const signupLink = document.createElement('a');
    signupLink.href = '/developers/#/signup';
    const signupBtn = document.createElement('button');
    signupBtn.className = 'start';
    signupBtn.textContent = 'Get started';
    signupLink.appendChild(signupBtn);

    logins.append(loginLink, signupLink);
}

function renderLoggedIn(dev) {
    if (!logins) return;
    logins.innerHTML = '';

    const label = dev.name || dev.email || 'Account';
    const profileLink = document.createElement('a');
    profileLink.href = '/developers/#/apps';
    profileLink.className = 'nav-profile-link';

    const fallback = document.createElement('span');
    fallback.className = 'nav-avatar nav-avatar-fallback';
    fallback.textContent = label.charAt(0).toUpperCase();
    profileLink.appendChild(fallback);

    const nameSpan = document.createElement('span');
    nameSpan.className = 'nav-username';
    nameSpan.textContent = label;
    profileLink.appendChild(nameSpan);

    const logoutBtn = document.createElement('button');
    logoutBtn.type = 'button';
    logoutBtn.className = 'nav-logout';
    logoutBtn.title = 'Log out';
    logoutBtn.setAttribute('aria-label', 'Log out');
    logoutBtn.innerHTML = '<i class="fas fa-arrow-right-from-bracket"></i>';
    logoutBtn.addEventListener('click', () => {
        clearToken();
        renderLoggedOut();
    });

    // Wrapped in one row so the chip and logout button stay side-by-side
    // even inside .logins.active's column layout on mobile.
    const row = document.createElement('div');
    row.className = 'nav-account-row';
    row.append(profileLink, logoutBtn);
    logins.append(row);
}

async function checkAuth() {
    const token = readToken();
    if (!token) {
        renderLoggedOut();
        return;
    }

    try {
        const res = await fetch('/api/v1/platform/auth/me', {
            headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error('Session is no longer valid');
        renderLoggedIn(await res.json());
    } catch {
        clearToken();
        renderLoggedOut();
    }
}

checkAuth();
