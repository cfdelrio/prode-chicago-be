"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.loggingMiddleware = exports.compressionMiddleware = exports.corsMiddleware = exports.securityMiddleware = void 0;
const helmet_1 = __importDefault(require("helmet"));
const cors_1 = __importDefault(require("cors"));
const compression_1 = __importDefault(require("compression"));
const morgan_1 = __importDefault(require("morgan"));
const config_1 = require("../config");
exports.securityMiddleware = (0, helmet_1.default)({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com"],
            imgSrc: ["'self'", "data:", "https:", "blob:"],
            scriptSrc: ["'self'"],
            connectSrc: ["'self'", "https://t49euho172.execute-api.us-east-1.amazonaws.com", "https://*.prodecaballito.com", "https://engage.orkestai.ar"],
        },
    },
    crossOriginEmbedderPolicy: false,
});
const allowedOrigins = [
    'http://localhost:3000',
    'http://localhost:5173',
    'https://d2vjb37mnj30m1.cloudfront.net',
    'https://d16s2xc71j0bqo.cloudfront.net',
    'https://prodecaballito.com',
    'https://www.prodecaballito.com',
];
exports.corsMiddleware = (0, cors_1.default)({
    origin: function (origin, callback) {
        if (!origin) {
            callback(null, true);
            return;
        }
        if (allowedOrigins.includes(origin)) {
            callback(null, true);
        }
        else {
            callback(new Error(`Origin not allowed by CORS: ${origin}`));
        }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-internal-secret'],
    exposedHeaders: ['Content-Length', 'X-Request-Id'],
    maxAge: 86400,
});
exports.compressionMiddleware = (0, compression_1.default)();
exports.loggingMiddleware = (0, morgan_1.default)('combined', {
    skip: (req) => req.url === '/health',
});
//# sourceMappingURL=common.js.map