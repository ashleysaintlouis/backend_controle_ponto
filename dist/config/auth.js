"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SUPPORTED_LANGUAGES = exports.JWT_SECRET = exports.DEFAULT_LANGUAGE = exports.DEFAULT_TIME_FORMAT = exports.DEFAULT_TIMEZONE = void 0;
exports.normalizeEmail = normalizeEmail;
exports.isPasswordStrong = isPasswordStrong;
exports.getGoogleOAuthEnabled = getGoogleOAuthEnabled;
exports.DEFAULT_TIMEZONE = 'America/Sao_Paulo';
exports.DEFAULT_TIME_FORMAT = 'H24';
exports.DEFAULT_LANGUAGE = 'pt-BR';
exports.JWT_SECRET = process.env.JWT_SECRET ?? 'controle-ponto-dev-secret';
exports.SUPPORTED_LANGUAGES = ['ht', 'fr', 'en', 'pt-BR', 'es'];
function normalizeEmail(email) {
    return email.trim().toLowerCase();
}
function isPasswordStrong(password) {
    if (!password || password.length < 8) {
        return false;
    }
    const hasUppercase = /[A-Z]/.test(password);
    const hasLowercase = /[a-z]/.test(password);
    const hasNumber = /\d/.test(password);
    const hasSymbol = /[^A-Za-z0-9]/.test(password);
    return hasUppercase && hasLowercase && hasNumber && hasSymbol;
}
function getGoogleOAuthEnabled() {
    return process.env.ALLOW_GOOGLE_OAUTH !== 'false' && Boolean(process.env.GOOGLE_CLIENT_ID);
}
