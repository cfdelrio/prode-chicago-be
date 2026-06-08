"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.config = void 0;
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
exports.config = {
    port: parseInt(process.env.PORT || '3001', 10),
    nodeEnv: process.env.NODE_ENV || 'development',
    database: {
        host: process.env.DB_HOST || 'localhost',
        port: parseInt(process.env.DB_PORT || '5432', 10),
        name: process.env.DB_NAME || 'prode',
        user: process.env.DB_USER || 'postgres',
        password: process.env.DB_PASSWORD || 'postgres',
    },
    redis: {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379', 10),
        password: process.env.REDIS_PASSWORD,
    },
    jwt: {
        secret: process.env.JWT_SECRET || (() => { if (process.env.NODE_ENV === 'production') throw new Error('JWT_SECRET env var is required in production'); return 'dev-secret-change-in-production'; })(),
        expiresIn: process.env.JWT_EXPIRES_IN || '15m',
        refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
    },
    aws: {
        region: process.env.AWS_REGION || 'us-east-1',
        s3Bucket: process.env.S3_BUCKET_UPLOADS || 'prode-uploads',
        cdnUrl: process.env.CDN_URL || 'https://d16s2xc71j0bqo.cloudfront.net',
        sesFromEmail: process.env.SES_FROM_EMAIL || 'noreply@prode.com',
    },
    app: {
        url: process.env.APP_URL || 'http://localhost:3000',
        apiUrl: process.env.API_URL || 'http://localhost:3001',
    },
    limits: {
        maxMessagesBetweenUsers: parseInt(process.env.MAX_MESSAGES || '5', 10),
        maxCommentsPerMinute: parseInt(process.env.MAX_COMMENTS_PER_MIN || '5', 10),
        maxLoginAttempts: parseInt(process.env.MAX_LOGIN_ATTEMPTS || '5', 10),
    },
    upload: {
        maxSize: 5 * 1024 * 1024, // 5MB
        allowedTypes: ['image/jpeg', 'image/png', 'image/webp'],
    },
};
//# sourceMappingURL=index.js.map