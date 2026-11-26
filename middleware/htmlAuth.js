const jwt = require('jsonwebtoken');
const User = require('../models/User');

const htmlAuth = async (req, res, next) => {
  try {
    // The `token` cookie set by POST /api/v1/auth/login. ?oven= only with ALLOW_QUERY_TOKEN=true (see middleware/auth.js).
    let token = req.cookies?.token || (process.env.ALLOW_QUERY_TOKEN === 'true' ? req.query.oven : undefined);

    if (!token || token === 'undefined') {
      return res.redirect('/api/v1/bundle/login');
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    const user = await User.findById(decoded.userId).select('-password');

    if (!user) {
      return res.redirect('/api/v1/bundle/login');
    }

    // Attach user if needed
    req.user = user;
    next();
  } catch (err) {
    return res.redirect('/api/v1/bundle/login');
  }
};

module.exports = htmlAuth;
