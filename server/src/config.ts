export interface Config {
  port: number;
  jwtSecret: string;
  inviteSecret: string;
  identifierPepper: string;
  accessTtlSec: number;
  refreshTtlSec: number;
  otpTtlSec: number;
  devReturnOtp: boolean;
  adminToken: string | undefined;
  dbFile: string;
  expoPushEnabled: boolean;
  turnUrls: string[];
  turnUsername?: string;
  turnCredential?: string;
  /** OpenMLS AS/DS directory. Default off so the nacl path stays live. */
  mlsDirectoryEnabled: boolean;
}

export function loadConfig(over: Partial<Config> = {}): Config {
  const env = process.env;
  const prod = env.NODE_ENV === 'production';
  const need = (k: string, dev: string) => {
    const v = env[k];
    if (!v && prod) throw new Error(`${k} must be set in production`);
    return v || dev;
  };
  return {
    port: Number(env.PORT || 4000),
    jwtSecret: need('JWT_SECRET', 'dev-jwt-secret-change-me'),
    inviteSecret: need('INVITE_SECRET', 'dev-invite-secret-change-me'),
    identifierPepper: need('IDENTIFIER_PEPPER', 'dev-pepper'),
    accessTtlSec: Number(env.ACCESS_TTL_SEC || 900),
    refreshTtlSec: Number(env.REFRESH_TTL_SEC || 60 * 60 * 24 * 60),
    otpTtlSec: 600,
    devReturnOtp: !prod && env.DEV_RETURN_OTP !== '0',
    adminToken: env.ADMIN_TOKEN,
    dbFile: env.DB_FILE || './understage.db',
    expoPushEnabled: env.EXPO_PUSH_ENABLED === '1',
    turnUrls: (env.TURN_URLS || '').split(',').filter(Boolean),
    turnUsername: env.TURN_USERNAME,
    turnCredential: env.TURN_CREDENTIAL,
    mlsDirectoryEnabled: env.MLS_DIRECTORY_ENABLED === '1',
    ...over,
  };
}
