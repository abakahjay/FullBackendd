require('dotenv').config();
const fs = require('fs');
require('express-async-errors');
require('./utils/keepOriginalHandlers'); // for the API docs


//This is just saving the path into a variable and exporting it to use elsewhere
const appPath = __dirname;
module.exports = { appPath };
const swaggerUi = require('swagger-ui-express');
const swaggerJsdoc = require('swagger-jsdoc');
const expressJSDocSwagger = require('express-jsdoc-swagger');





const path = require('path');
//This are all the files required to run this application
const express = require('express');
const bodyParser = require("body-parser");
const logger = require("morgan");
const app = express();
const expressOasGenerator = require('express-oas-generator');
// expressOasGenerator.init(app, {
//     writeIntervalMs: 3000, // write faster
//     swaggerUiServePath: '/api-docs',
// });
const cors = require("cors");
const connectDB = require('./db/connect.js');
const mongoose = require('mongoose')
const helmet = require('helmet');
const morgan = require('morgan');
const { notFound } = require('./middleware/not-found.js');
const errorHandler = require('./middleware/error-handler.js')
const homepage = require('./routes/homepage.js');
const authRoutes = require("./routes/auth.js");
const uploadRoutes = require("./routes/upload.js");
const productsRouter = require('./routes/products.js')
const cartRouter = require('./routes/cart.js')
const ordersRouter = require('./routes/orders.js')
const transactionRoutes = require('./routes/transactionRoutes.js')
const ordersdataRouter = require('./routes/MTNOrders.js')
const testing1Router = require('./routes/testing1.js')
const deliveryRouter = require('./routes/delivery.js')
const changeDelRouter = require('./routes/cart2.js')
const messageRoutes = require('./routes/messageRoutes');
const socialNotificationRoutes = require('./routes/socialNotificationRoutes');
const setupSocket = require('./utils/socket');
const userRoutes = require('./routes/userRoute');
const userProfilePic = require('./routes/userProfilePic');
const postRoutes = require('./routes/postRoute');
const commentRoutes = require('./routes/commentRoute');
const googleAuth = require('./routes/googleAuth');
const aiRoutes = require('./routes/chatAi');
const aiModelRoutes = require('./routes/aiModel');
const aiImageRoutes = require('./routes/sendAiImage');
const uniServe = require('./routes/UniServe.js');//Uniserver
const passport = require("passport");
const downloadExcelRoute = require('./routes/downloadExcel');
const ussdRoutes = require("./routes/ussdRoutes");
const muviinRoutes = require("./routes/muviin");
const ussd = require("./routes/ussd.js");
const authMiddleware = require("./middleware/auth.js");
const htmlAuth = require('./middleware/htmlAuth'); // Import it
const writeGuard = require('./middleware/writeGuard');
const reloadlyRoutes = require('./routes/reloadlyRoutes');
const { ClerkExpressRequireAuth } = require("@clerk/clerk-sdk-node");//This handles user logins  and stuff
const paystackRoutes = require("./routes/paystackRouter");
const bundleRoutes = require('./routes/bundleRoutes');
const afaRoutes = require('./routes/afa');
const mealRoutes = require("./routes/mealRoutes");
const foodordersRoutes = require("./routes/foodorders");

const feedbackRoutes = require("./routes/foodFeedback");
const portfolioRoutes = require("./routes/portfolio.js");
const seedbridgeAuthRoutes = require("./routes/seedbridgeAuthRoutes.js");
const seedbridgeProduceRoutes = require("./routes/seedbridgeProduce.js");
const seedbridgeOrderRoutes = require("./routes/seedbridgeOrder.js");
const seedbridgePaymentRoutes = require("./routes/seedbridgePayment.js");
const seedbridgeDashboardRoutes = require("./routes/seedbridgeDashboard.js");
const seedbridgeUssdRoutes = require("./routes/seedbridgeUssd.js");
const cleanbridgeAuthRoutes = require("./routes/cleanbridgeAuth.js");
const cleanbridgePickupRoutes = require("./routes/cleanbridgePickup.js");
const cleanbridgeRouteRoutes = require("./routes/cleanbridgeRoute.js");
const cleanbridgeVehicleRoutes = require("./routes/cleanbridgeVehicle.js");
const cleanbridgeNotificationRoutes = require("./routes/cleanbridgeNotification.js");
const cleanbridgeSettingsRoutes = require("./routes/cleanbridgeSettings.js");
const cleanbridgeDashboardRoutes = require("./routes/cleanbridgeDashboard.js");
const cleanbridgeAdminRoutes = require("./routes/cleanbridgeAdmin.js");
const cleanbridgeGeoRoutes = require("./routes/cleanbridgeGeo.js");
const cleanbridgePaymentRoutes = require("./routes/cleanbridgePayment.js");
const cleanbridgePayoutRoutes = require("./routes/cleanbridgePayout.js");
const cleanbridgeEmailRoutes = require("./routes/cleanbridgeEmail.js");
const cleanbridgeEventRoutes = require("./routes/cleanbridgeEvents.js");
const cleanbridgeSubscriptionRoutes = require("./routes/cleanbridgeSubscription.js");
// console.log(ClerkExpressRequireAuth)


const { spawn } = require('child_process');//Used to run python code with javascript
require("./utils/passport"); // Passport configuration file





// Render (and any host with TRUST_PROXY=<hops>) sits behind one proxy: without
// this, req.ip is the proxy for every visitor and all IP rate limits are shared.
if (process.env.TRUST_PROXY || process.env.RENDER) {
    app.set('trust proxy', Number(process.env.TRUST_PROXY) || 1);
}
app.disable('x-powered-by');
// Set by the SIGTERM/SIGINT handler at the bottom; /readyz answers 503 once it is true.
let shuttingDown = false;

// Liveness/readiness probe for Render/PM2/uptime monitors: 200 only when Mongo is connected.
app.get('/healthz', (req, res) => {
    const up = mongoose.connection.readyState === 1;
    res.status(up ? 200 : 503).json({ status: up ? 'ok' : 'degraded', db: up ? 'up' : 'down', uptime: Math.round(process.uptime()) });
});

// Readiness: actually round-trips to Mongo (2s cap) and answers 503 while shutting down, so a
// load balancer stops sending traffic before the process exits. Use for uptime monitors.
app.get('/readyz', async (req, res) => {
    if (shuttingDown) return res.status(503).json({ status: 'shutting_down' });
    const started = Date.now();
    try {
        if (mongoose.connection.readyState !== 1) throw new Error('not connected');
        await Promise.race([
            mongoose.connection.db.admin().ping(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000)),
        ]);
        const mem = process.memoryUsage();
        res.set('Cache-Control', 'no-store').json({
            status: 'ready',
            db: 'up',
            dbPingMs: Date.now() - started,
            uptime: Math.round(process.uptime()),
            rssMb: Math.round(mem.rss / 1048576),
            heapUsedMb: Math.round(mem.heapUsed / 1048576),
        });
    } catch (err) {
        res.status(503).set('Cache-Control', 'no-store').json({ status: 'not_ready', db: 'down', error: err.message });
    }
});

// Security headers + the global /api rate limit run FIRST, so the upload, AI, posts and
// other routers mounted before the body parsers are covered too. CSP stays per-area
// (set further down), and resources may be embedded cross-origin by our own frontends.
app.use(require('helmet')({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' } }));
const apiLimiter = require('express-rate-limit')({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: Number(process.env.API_RATE_LIMIT_PER_15_MIN) || 3000,
    standardHeaders: true,
    legacyHeaders: false,
    message: { msg: 'Too many requests. Please slow down and try again shortly.' },
});
app.use('/api/', apiLimiter);

// Any origin may call the API with a Bearer token; cookies are honoured only for
// our own frontends (utils/corsPolicy.js - add new ones to CORS_ORIGINS).
app.use(cors(require('./utils/corsPolicy').corsOptions));
// The hand-written swagger.yaml (portfolio /contact and /order) keeps its own
// page. Mounted before /api-docs so that route doesn't swallow it.
const YAML = require('yamljs');
const portfolioSwaggerPath = path.join(__dirname, 'swagger.yaml');
if (fs.existsSync(portfolioSwaggerPath)) {
    const portfolioSwaggerSpec = YAML.load(portfolioSwaggerPath);
    app.use('/api-docs/portfolio', swaggerUi.serveFiles(portfolioSwaggerSpec), swaggerUi.setup(portfolioSwaggerSpec));
}

// API docs for EVERY route, built live from the Express router on first view
// (utils/apiDocs.js), so they never go stale. Labels and examples live in
// docs/apiAnnotations.js. Raw spec: /api-docs.json.
const { getSpec } = require('./utils/apiDocs');
const apiDocsUi = {
    customSiteTitle: 'FullBackendd API docs',
    swaggerOptions: { url: '/api-docs.json', docExpansion: 'none', filter: true, persistAuthorization: true, displayRequestDuration: true },
};
app.get('/api-docs.json', (req, res) => res.json(getSpec(app)));
app.use('/api-docs', swaggerUi.serveFiles(null, apiDocsUi), swaggerUi.setup(null, apiDocsUi));


// Serve the uploaded images from the /uploads folder in code
app.use("/api/v1/auth/", uploadRoutes);

// IMPORTANT: must be registered BEFORE bodyParser.json()/express.json()
// below. Paystack's webhook signature is an HMAC over the raw request
// bytes - once a JSON parser has turned the body into a JS object, the
// original bytes are gone and the signature can no longer be verified.
const SEEDBRIDGE_WEBHOOK_PATH = '/api/v1/seedbridge/payments/webhook';
app.use(SEEDBRIDGE_WEBHOOK_PATH, express.raw({ type: 'application/json' }));

// GhanaCropGuard AI (crop disease photo classifier). Mounted before every global
// body parser/sanitizer: the router parses, validates and secures its own
// namespace and answers every request under it (routes/cropguard.js).
app.use('/api/v1/cropguard', require('./routes/cropguard.js'));

// JayRouter database backups (encrypted SQLite snapshots). Before the global
// parsers: uploads are raw octet-stream bytes (routes/jayrouterBackup.js).
app.use('/api/v1/jayrouter', require('./routes/jayrouterBackup.js'));

// CODM Campus Showdown (UMaT Call of Duty: Mobile tournament). Before the global
// parsers like CropGuard: it parses and validates its own input, and its Paystack
// webhook needs the raw body (routes/codm.js).
app.use('/api/v1/codm', require('./routes/codm.js'));

// Developer platform: developers register apps (frontend URLs + data collections) and
// get a generated API for each. Same rule as CropGuard: mounted before the global
// parsers/sanitizers because it validates its own input (routes/platform.js).
const platformRoutes = require('./routes/platform.js');
app.use('/api/v1/platform', platformRoutes.platform);
app.use('/api/v1/apps', platformRoutes.runtime);
// The developer dashboard keeps a token in localStorage: only its own scripts may run.
app.use('/developers', (req, res, next) => {
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
});

app.use((req, res, next) => {
    if (req.originalUrl === SEEDBRIDGE_WEBHOOK_PATH) {
        return next(); // already raw-parsed above; don't let this overwrite req.body
    }
    return bodyParser.json()(req, res, next);
});
// The CleanBridge live stream carries its token in the query string - keep it out of the logs.
// Tokens can arrive in the query string (?oven=, ?token=) - never write them to the logs.
logger.token('safe-url', (req) => String(req.originalUrl || req.url).replace(/([?&](?:oven|token|access_token|code)=)[^&]*/gi, '$1[redacted]'));
app.use(logger(':method :safe-url :status :response-time ms - :res[content-length]', { skip: (req) => req.originalUrl.startsWith("/api/v1/cleanbridge/events") }));
// app.use(morgan('tiny'))


//We put all the file upload routes up here so that it doesn't get affected by some middleware for json
// Serve the uploaded images from the /uploads folder in database
app.use('/api/v1/uploadFiles/', testing1Router)

app.use('/api/v1/userse', userProfilePic);
//This is for posts

app.use('/api/v1/posts', postRoutes);
// Nsoro moments (multipart upload, so it sits with posts before the JSON body parsers)
app.use('/api/v1/stories', require('./routes/storyRoutes'));
// Voice notes in DMs (multipart too); the rest of /api/v1/messages is mounted later
app.use('/api/v1/messages/voice', require('./routes/messageVoiceRoute'));
// Nsoro logged-in uploads (new post, profile photo); JSON routes mounted later
app.use('/api/v1/nsoro', require('./routes/nsoroUploadRoutes'));
// GH-GPT image upload (multipart); the JSON GH-GPT routes are mounted later
app.use('/api/v1/ghgpt', require('./routes/ghgptUploadRoutes'));
app.use('/api/v1/ai', aiImageRoutes);
app.use('/api/v1/ai', aiModelRoutes);

// Meals: reading the menu is public; writes need an admin/caterer token (middleware/writeGuard.js).
app.use("/api/v1/meals", writeGuard({ roles: ['admin', 'caterer'], ownerField: 'createdBy' }), mealRoutes);

// Initialize Passport
app.use(passport.initialize());


// rest of the packages
const cookieParser = require('cookie-parser');
const fileUpload = require('express-fileupload');
const rateLimiter = require('express-rate-limit');
const xss = require('xss-clean');
const mongoSanitize = require('express-mongo-sanitize');


//All this is for license for https secure
const https = require('https');
// const sslOptions = {
    //     key: fs.readFileSync('./key.pem'), // Path to your private key
    //     cert: fs.readFileSync('./cert.pem') // Path to your certificate
    // };
    
    
    //This is for the messaging
const http = require('http');
// const socketIo = require('socket.io');
const server = http.createServer(app);
// Any origin may connect (the Nsoro web, Android TWA, Windows Electron and Expo apps all differ):
// every socket must present a valid JWT in `auth.token` (utils/socket.js io.use), and no cookies
// are accepted, so an open origin can't be abused. Messages are capped at 1 MB.
const io = require('socket.io')(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST'],
        credentials: false,
    },
    maxHttpBufferSize: 1e6,
    pingTimeout: 20000,
});






//Middleware




// app.use(session({
//     secret: process.env.SESSION_KEY,
//     resave: true,
//     saveUninitialized: true,
// }));
// app.use(morgan('tiny'));
// The old account pages are replaced by the developer portal, which also accepts
// existing FullBackend accounts (controllers/platformDevelopers.js login).
const PORTAL_REDIRECTS = { login: '#/signin', signup: '#/signup', dashboard: '#/apps' };
app.get(['/login', '/login/login.html', '/signup', '/signup/signup.html', '/dashboard', '/dashboard/dashboard.html'], (req, res) => {
    res.redirect(302, `/developers/${PORTAL_REDIRECTS[req.path.split('/')[1]]}`);
});
app.use(express.static('./public'))
app.use(express.static('./static'))


// Use Helmet for security
app.use(helmet());


//Other middleware
// Per client IP (see trust proxy above). Generous: ~3 requests a second, sustained.
// The global /api rate limiter is registered at the top of the file.


app.use((req, res, next) => {
    if (req.originalUrl === SEEDBRIDGE_WEBHOOK_PATH) {
        return next(); // req.body is a raw Buffer here - these sanitizers expect parsed objects
    }
    return xss()(req, res, next);
});
app.use((req, res, next) => {
    if (req.originalUrl === SEEDBRIDGE_WEBHOOK_PATH) {
        return next();
    }
    return mongoSanitize()(req, res, next);
});
app.use(cookieParser(process.env.JWT_SECRET));
// Uploads are held in memory: cap them so one request can't exhaust the server.
app.use(fileUpload({
    limits: { fileSize: (Number(process.env.MAX_UPLOAD_MB) || 50) * 1024 * 1024, files: 10 },
    abortOnLimit: true,
    responseOnLimit: JSON.stringify({ msg: 'File is too large.' }),
}));


// Parse incoming JSON requests
app.use(express.urlencoded({ extended: false }));
app.use((req, res, next) => {
    if (req.originalUrl === SEEDBRIDGE_WEBHOOK_PATH) {
        return next();
    }
    return express.json()(req, res, next);
});


// Routes to API's
app.use("/api/v1/auth", authRoutes);
app.use("/api/v1/auth", googleAuth);
app.use('/api/v1/products', productsRouter)
app.use('/api/v1/cart', cartRouter)
app.use('/api/v1/orders', ordersRouter)
app.use('/api/v1/transactions', transactionRoutes)
app.use('/api/v1/ordersdata', ordersdataRouter)
app.use('/api/v1/delivery', deliveryRouter)
app.use('/api/v1/changedel', changeDelRouter)
app.use('/api/v1/messages', messageRoutes);
app.use('/api/v1/notifications', socialNotificationRoutes);
// Nsoro: email unsubscribe, email settings, admin app-update emails
app.use('/api/v1/nsoro', require('./routes/nsoroRoutes'));
app.use('/api/v1/users', userRoutes);

app.use('/api/v1/comments', commentRoutes);

//This is for the Ai
app.use('/api/v1/ai', aiRoutes);
// GH-GPT logged-in API: streaming answers, chat titles, emails, settings
app.use('/api/v1/ghgpt', require('./routes/ghgpt'));
// Web Push device notifications for every app (utils/push.js)
app.use('/api/v1/push', require('./routes/push'));


// UniServe: adding universities/programs is admin-only; students can still submit their inputs.
app.use('/api/v1/uniserve/universities', writeGuard({ roles: ['admin'] }));
app.use('/api/v1/uniserve/programs', writeGuard({ roles: ['admin'] }));
app.use('/api/v1/uniserve', uniServe);

app.use('/api/v1/export', downloadExcelRoute);

app.use("/api/v1/ussd", ussdRoutes);

app.use("/api/v1/muviin", muviinRoutes);

app.use("/api/v1/ussds", ussd);
app.use('/api/v1/reloadly', reloadlyRoutes);

// Use Routes
app.use("/api/v1/paystack", paystackRoutes);

app.use('/api/v1/bundles', bundleRoutes);

app.use('/api/v1/afa', afaRoutes);

app.use("/api/v1/foodorders", foodordersRoutes);

// Feedback: reading is public; writes need a signed-in user, who is always the author.
app.use("/api/v1/feedbacks", writeGuard({ ownerField: 'userId' }), feedbackRoutes);

// Portfolio site forms (matches frontend's fetch('api/contact') / fetch('api/order'))

app.use("/api", portfolioRoutes);

// SeedBridge (farm-to-market app) - fully namespaced under /api/v1/seedbridge
// so nothing here can collide with any other app's routes on this backend.
// Its own SeedBridgeUser model/auth is separate from the shared User model.
app.use('/api/v1/seedbridge/auth', seedbridgeAuthRoutes);
app.use('/api/v1/seedbridge/produce', seedbridgeProduceRoutes);
app.use('/api/v1/seedbridge/orders', seedbridgeOrderRoutes);
app.use('/api/v1/seedbridge/payments', seedbridgePaymentRoutes);
app.use('/api/v1/seedbridge/dashboard', seedbridgeDashboardRoutes);
app.use('/api/v1/seedbridge/ussd', seedbridgeUssdRoutes);

// CleanBridge GH (Accra waste-collection app) - fully namespaced under
// /api/v1/cleanbridge with its own CleanBridgeUser model/auth, like SeedBridge.
app.use('/api/v1/cleanbridge/auth', cleanbridgeAuthRoutes);
app.use('/api/v1/cleanbridge/pickups', cleanbridgePickupRoutes);
app.use('/api/v1/cleanbridge/routes', cleanbridgeRouteRoutes);
app.use('/api/v1/cleanbridge/vehicles', cleanbridgeVehicleRoutes);
app.use('/api/v1/cleanbridge/notifications', cleanbridgeNotificationRoutes);
app.use('/api/v1/cleanbridge/settings', cleanbridgeSettingsRoutes);
app.use('/api/v1/cleanbridge/dashboard', cleanbridgeDashboardRoutes);
app.use('/api/v1/cleanbridge/admin', cleanbridgeAdminRoutes);
app.use('/api/v1/cleanbridge/geo', cleanbridgeGeoRoutes);
app.use('/api/v1/cleanbridge/payments', cleanbridgePaymentRoutes);
app.use('/api/v1/cleanbridge/payouts', cleanbridgePayoutRoutes);
app.use('/api/v1/cleanbridge/email', cleanbridgeEmailRoutes);
app.use('/api/v1/cleanbridge/events', cleanbridgeEventRoutes);
app.use('/api/v1/cleanbridge/subscriptions', cleanbridgeSubscriptionRoutes);




//This is the login page for the mtn data login


// Loosen CSP to allow inline scripts and styles
app.use((req, res, next) => {
    res.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; " +
        "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; " +
        "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; " +
        "font-src 'self' https://cdnjs.cloudflare.com; " +
        "img-src 'self' data: blob: https://www.gravatar.com https://s3.amazonaws.com https://*.googleusercontent.com https://ik.imagekit.io;"
    );
    next();
});


app.get('/api/v1/bundle/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'static', 'login.html'));
});

//This is the dashboard page for the mtn data bundle page
app.get('/api/v1/bundle/', htmlAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'static', 'afrodata.html'));
});

app.get('/api/v1/buydata/', htmlAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'static', 'buydata.html'));
});
app.get('/static/favicon.ico', (req, res) => {
    res.sendFile(path.join(__dirname, 'static', 'favicon.ico'));
});

app.get('/afrodatahome', (req, res) => {
    res.sendFile(path.join(__dirname, 'static', 'afrohome.html'));
});

app.get('/afrodatadashboard',htmlAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'static', 'dashboard.html'));
});

app.get('/resetPassword', (req, res) => {
    res.sendFile(path.join(__dirname, 'static', 'resetPassword.html'));
});

// Hosted "forgot password" page (?app=shared|seedbridge|cleanbridge&return=), for
// frontends without their own; its email links to /resetPassword above.
app.get('/forgotPassword', (req, res) => {
    res.sendFile(path.join(__dirname, 'static', 'forgotPassword.html'));
});

app.get('/datasuccess', (req, res) => {
    res.sendFile(path.join(__dirname, 'static', 'success.html'));
});

app.get('/font-awesome/css/all.min.css', (req, res) => {
    res.sendFile(path.join(__dirname, 'static', '/font-awesome/css/all.min.css'));
});


//This is for the Ai Chatbot
app.post('/api/chat', (req, res) => {
    const userMessage = req.body.message;
    // Passed as one argv entry (no shell), but still bounded: it starts a process per request.
    if (typeof userMessage !== 'string' || !userMessage.trim() || userMessage.length > 2000) {
        return res.status(400).json({ msg: 'message must be text of at most 2000 characters' });
    }

    const python = spawn(process.env.PYTHON_BIN || 'C:/ProgramData/anaconda4/python.exe', ['./chatbot/respond.py', userMessage]);//This is used to run python in javascript
    python.on('error', () => !res.headersSent && res.status(503).json({ msg: 'Chatbot is not available on this server.' }));
    setTimeout(() => python.kill(), 30000).unref();

    python.stdout.on('data', (data) => {
        res.json({ reply: data.toString() });//This will send the printed message
    });

    python.stderr.on('data', (data) => {//This will send the error
        console.error(`Error: ${data}`);
    });
});

// Setup Socket.IO
setupSocket(io);

app.use(homepage)


// Basic error handling middleware
app.use(notFound);
app.use(errorHandler);


//This app has a listening problem
const port = process.env.PORT || 7004;
//If there are  port problems :   npx kill-port 7004 


const start = async () => {
    // Fail fast on a missing MONGO_URI / JWT_SECRET (utils/checkEnv.js); weak secrets only warn.
    if (!require('./utils/checkEnv').assertEnv()) {
        console.error('[env] fix the variables above (see .env.example), then restart.');
        process.exit(1);
    }
    try {
        //Connect the Database
        //We must always include our connect database method in the server application
        await connectDB(process.env.MONGO_URI).then(() => {
            console.log('\x1b[36m%s\x1b[0m', '🔄Connected to MongoDB...')
            // Host only: the full URI contains the database password.
            console.log('\x1b[36m%s\x1b[0m', '🔌 Connected to:', String(process.env.MONGO_URI).replace(/\/\/[^@/]*@/, '//***@').split('?')[0]);
        })
        // Security audit: until 2026-10-24 /auth/signup accepted role "admin" from anyone, so list
        // every admin at startup (username, masked email, creation date) for the owner to review.
        try {
            const admins = await require('./models/User.js').find({ role: 'admin' }, { username: 1, email: 1, createdAt: 1, created: 1 }).lean();
            const mask = (e) => String(e || '').replace(/^(.).*?(@.*)$/, '$1***$2');
            console.log(`[security] admin accounts: ${admins.length}` + admins.map((a) => `\n  - ${a.username} ${mask(a.email)} created ${new Date(a.createdAt || a.created || 0).toISOString().slice(0, 10)}`).join(''));
        } catch (err) {
            console.log(`[security] admin audit failed: ${err.message}`);
        }

        server.listen(port, console.log('\x1b[42m%s\x1b[0m', `🚀 Server Running on === http://localhost:${port}`));
        // https.createServer(sslOptions, app).listen(port, () => {
        //     console.log(`Server running on https://localhost:${port}`);
        // });
    } catch (error) {
        console.log('Could not connect to MongoDB...');
        console.log(`Error: ${error}`);
        // Exit so the process manager (PM2/Render/nodemon) restarts us instead of
        // leaving a process that is up but serving nothing.
        process.exit(1);
    }
}

process.on('unhandledRejection', (reason) => {
    console.error('[unhandledRejection]', reason);
});
// A thrown error nobody caught leaves the process in an unknown state: log it and exit so
// PM2/Render start a clean one (graceful shutdown first, hard stop after 10s).
process.on('uncaughtException', (err) => {
    console.error('[uncaughtException]', err);
    shutdown('uncaughtException', 1);
});

// Graceful shutdown: stop taking new connections, let in-flight requests finish,
// close Mongo, then exit. Render/PM2 send SIGTERM on every deploy/restart.
const shutdown = (signal, code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[${signal}] shutting down...`);
    setTimeout(() => process.exit(1), 10000).unref();
    io.close();
    server.close(() => {
        mongoose.connection.close(false, () => process.exit(code));
    });
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
start();

