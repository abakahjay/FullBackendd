const jwt = require('jsonwebtoken');
const User = require('../models/User.js');
const { UnauthenticatedError, UnauthorizedError, NotFoundError } = require('../errors');

// Only HS256 is ever issued (models/User.js createJWT). Pinning it means a token
// with `alg: none` or another algorithm is rejected even if a library default changes.
const JWT_ALGORITHMS = ['HS256'];

// Where a token can come from, in priority order:
// 1. Authorization: Bearer <token>   (every SPA / mobile client)
// 2. the `token` cookie               (same-origin static pages: /afrodatadashboard, /api/v1/bundle/...)
// 3. ?oven=<token>  only when ALLOW_QUERY_TOKEN=true. Tokens in URLs leak into browser history,
//    proxies and Referer headers; no live page sends one any more (the old public/dashboard
//    pages that did now redirect to /developers). Kept as an emergency switch.
function readToken(req) {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const t = authHeader.slice(7).trim();
        if (t && t !== 'undefined' && t !== 'null') return t;
    }
    if (req.cookies?.token) return req.cookies.token;
    if (process.env.ALLOW_QUERY_TOKEN === 'true' && typeof req.query?.oven === 'string' && req.query.oven) return req.query.oven;
    return null;
}

// Verifies the token and loads the user. Throws UnauthenticatedError on any problem.
async function resolveUser(token) {
    let decoded;
    try {
        decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: JWT_ALGORITHMS });
    } catch (error) {
        throw new UnauthenticatedError(`Not authorized: ${error.message}`);
    }
    const { userId, username } = decoded || {};
    // Tokens from the other apps (CleanBridge, CropGuard, CODM, platform) have no userId claim.
    if (!userId) throw new UnauthenticatedError('Not authorized: wrong token type.');
    const user = await User.findById(userId).select('role username').lean();
    if (!user) throw new UnauthenticatedError('User not found.');
    return { userId: String(userId), username, role: user.role || 'user' };
}

const authenticationMiddleware = async (req, res, next) => {
    const token = readToken(req);
    if (!token) {
        throw new UnauthenticatedError('No valid token provided.');
    }
    const u = await resolveUser(token);
    req.user = { ...u, token };
    next();
};

// Like authenticationMiddleware, but a request without any token continues as
// anonymous (req.user stays undefined). A token that IS sent must be valid.
// Used by the demo shop (cart/orders), whose frontend has no login yet.
const optionalAuth = async (req, res, next) => {
    const token = readToken(req);
    if (!token) return next();
    const u = await resolveUser(token);
    req.user = { ...u, token };
    next();
};

// Usage: router.get('/x', authMiddleware, requireRole('admin', 'caterer'), handler)
// (same shape as requireRole in middleware/cleanbridgeAuth.js). The role is
// read from the database on every request (resolveUser), never from the token or body.
const requireRole = (...roles) => {
    const guard = (req, res, next) => {
        if (!req.user) throw new UnauthenticatedError('No valid token provided.');
        if (!roles.includes(req.user.role)) {
            throw new UnauthorizedError(`Access denied. Requires role: ${roles.join(' or ')}`);
        }
        next();
    };
    guard.roles = roles; // read by utils/apiDocs.js
    return guard;
};

const isAdmin = (req) => req.user?.role === 'admin';

// For older routes that carry the owner in the URL (/chats/:userId/...): the id
// must be the caller's own. Another user's id answers 404, like a missing record,
// so ids can't be probed. Usage: router.get('/x/:userId', authMiddleware, requireSelf(), h)
const requireSelf = (param = 'userId') => (req, res, next) => {
    if (!req.user) throw new UnauthenticatedError('No valid token provided.');
    if (String(req.params[param]) !== String(req.user.userId)) {
        throw new NotFoundError('Not found');
    }
    next();
};

module.exports = authenticationMiddleware;
module.exports.optionalAuth = optionalAuth;
module.exports.requireRole = requireRole;
module.exports.isAdmin = isAdmin;
module.exports.readToken = readToken;
module.exports.JWT_ALGORITHMS = JWT_ALGORITHMS;
module.exports.requireSelf = requireSelf;
