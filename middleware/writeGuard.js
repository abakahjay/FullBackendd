// Mount-level guard: reads (GET/HEAD/OPTIONS) stay public, every other method needs a
// shared User token whose DB role is in `roles`. With `ownerField`, the token's user id is
// written into req.body[ownerField] so a body can't claim to be someone else.
//
//   app.use('/api/v1/meals', writeGuard({ roles: ['admin', 'caterer'], ownerField: 'createdBy' }), mealRoutes)
const auth = require('./auth');
const { UnauthorizedError } = require('../errors');

const READ = new Set(['GET', 'HEAD', 'OPTIONS']);

module.exports = function writeGuard({ roles = null, ownerField = null } = {}) {
    return async (req, res, next) => {
        if (READ.has(req.method)) return next();
        try {
            await auth(req, res, () => {});
            if (roles && !roles.includes(req.user.role)) {
                throw new UnauthorizedError('You do not have permission to do this.');
            }
            if (ownerField && req.body && typeof req.body === 'object' && !Array.isArray(req.body)
                && req.user.role !== 'admin') {
                req.body[ownerField] = req.user.userId;
            }
            next();
        } catch (err) {
            next(err);
        }
    };
};
