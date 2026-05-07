"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.chunk = exports.calculatePercentage = exports.parseBetScore = exports.sanitizeHtml = exports.isBefore = exports.isAfter = exports.formatDate = exports.generateUUID = exports.verifyToken = exports.generateRefreshToken = exports.generateToken = exports.comparePassword = exports.hashPassword = void 0;
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const config_1 = require("../config");
const hashPassword = async (password) => {
    return bcryptjs_1.default.hash(password, 12);
};
exports.hashPassword = hashPassword;
const comparePassword = async (password, hash) => {
    return bcryptjs_1.default.compare(password, hash);
};
exports.comparePassword = comparePassword;
const generateToken = (payload, expiresIn = '15m') => {
    return jsonwebtoken_1.default.sign(payload, config_1.config.jwt.secret, { expiresIn });
};
exports.generateToken = generateToken;
const generateRefreshToken = (payload) => {
    return jsonwebtoken_1.default.sign(payload, config_1.config.jwt.secret, { expiresIn: '7d' });
};
exports.generateRefreshToken = generateRefreshToken;
const verifyToken = (token) => {
    return jsonwebtoken_1.default.verify(token, config_1.config.jwt.secret);
};
exports.verifyToken = verifyToken;
const generateUUID = () => {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
};
exports.generateUUID = generateUUID;
const formatDate = (date, locale = 'es-AR') => {
    return new Date(date).toLocaleDateString(locale, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    });
};
exports.formatDate = formatDate;
const isAfter = (date) => {
    return new Date() > new Date(date);
};
exports.isAfter = isAfter;
const isBefore = (date) => {
    return new Date() < new Date(date);
};
exports.isBefore = isBefore;
const sanitizeHtml = (html) => {
    const sanitizeHtml = require('sanitize-html');
    return sanitizeHtml(html, {
        allowedTags: ['b', 'i', 'em', 'strong', 'a'],
        allowedAttributes: {
            'a': ['href', 'target', 'rel']
        },
    });
};
exports.sanitizeHtml = sanitizeHtml;
const parseBetScore = (input) => {
    const cleaned = input.trim().replace(/\s+/g, '');
    const match = cleaned.match(/^(\d+)[-:](\d+)$/);
    if (!match)
        return null;
    const local = parseInt(match[1], 10);
    const visitante = parseInt(match[2], 10);
    if (local < 0 || visitante < 0 || local > 99 || visitante > 99)
        return null;
    return { local, visitante };
};
exports.parseBetScore = parseBetScore;
const calculatePercentage = (value, total) => {
    if (total === 0)
        return 0;
    return Math.round((value / total) * 100);
};
exports.calculatePercentage = calculatePercentage;
const chunk = (array, size) => {
    const chunks = [];
    for (let i = 0; i < array.length; i += size) {
        chunks.push(array.slice(i, i + size));
    }
    return chunks;
};
exports.chunk = chunk;
//# sourceMappingURL=index.js.map