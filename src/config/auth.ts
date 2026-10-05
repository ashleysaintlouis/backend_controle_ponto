export const DEFAULT_TIMEZONE = 'America/Sao_Paulo';
export const DEFAULT_TIME_FORMAT = 'H24';
export const DEFAULT_LANGUAGE = 'pt-BR';
export const JWT_SECRET = process.env.JWT_SECRET ?? 'controle-ponto-dev-secret';

export const SUPPORTED_LANGUAGES = ['ht', 'fr', 'en', 'pt-BR', 'es'] as const;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isPasswordStrong(password: string): boolean {
  if (!password || password.length < 8) {
    return false;
  }

  const hasUppercase = /[A-Z]/.test(password);
  const hasLowercase = /[a-z]/.test(password);
  const hasNumber = /\d/.test(password);
  const hasSymbol = /[^A-Za-z0-9]/.test(password);

  return hasUppercase && hasLowercase && hasNumber && hasSymbol;
}

export function getGoogleOAuthEnabled(): boolean {
  return process.env.ALLOW_GOOGLE_OAUTH !== 'false' && Boolean(process.env.GOOGLE_CLIENT_ID);
}
