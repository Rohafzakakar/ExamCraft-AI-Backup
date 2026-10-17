import crypto from 'node:crypto';
import { Request, Response, NextFunction } from 'express';
import { db, UserRecord } from './db';

const SECRET_KEY = process.env.SECRET_KEY || 'examcraft-antigravity-secret-key-phase1-2026';
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days expiration

export interface TokenPayload {
  userId: string;
  email: string;
  role: string;
  tokenVersion: number;
  issuedAt: number;
  expiresAt: number;
}

export interface AuthContext {
  userId: string | null;
  sessionId: string | null;
  isGuest: boolean;
  user: UserRecord | null;
}

declare global {
  namespace Express {
    interface Request {
      auth: AuthContext;
      user: UserRecord | null;
    }
  }
}

// Password Hashing via Node.js native scrypt
export function hashPassword(password: string): { salt: string; hash: string } {
  const salt = crypto.randomBytes(16).toString('hex');
  const derivedKey = crypto.scryptSync(password, salt, 64);
  return { salt, hash: derivedKey.toString('hex') };
}

export function verifyPassword(password: string, salt: string, expectedHash: string): boolean {
  try {
    const derivedKey = crypto.scryptSync(password, salt, 64);
    const keyBuffer = Buffer.from(derivedKey.toString('hex'), 'hex');
    const expectedBuffer = Buffer.from(expectedHash, 'hex');
    if (keyBuffer.length !== expectedBuffer.length) return false;
    return crypto.timingSafeEqual(keyBuffer, expectedBuffer);
  } catch {
    return false;
  }
}

// Token Generation & Verification
export function createToken(user: UserRecord): string {
  const now = Date.now();
  const payload: TokenPayload = {
    userId: user.id,
    email: user.email,
    role: user.role,
    tokenVersion: user.token_version,
    issuedAt: now,
    expiresAt: now + TOKEN_TTL_MS,
  };

  const payloadBase64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto
    .createHmac('sha256', SECRET_KEY)
    .update(payloadBase64)
    .digest('base64url');

  return `${payloadBase64}.${signature}`;
}

export function verifyToken(token: string): TokenPayload | null {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;

  const [payloadBase64, signature] = parts;
  const expectedSignature = crypto
    .createHmac('sha256', SECRET_KEY)
    .update(payloadBase64)
    .digest('base64url');

  const sigBuffer = Buffer.from(signature);
  const expBuffer = Buffer.from(expectedSignature);
  if (sigBuffer.length !== expBuffer.length) return null;
  if (!crypto.timingSafeEqual(sigBuffer, expBuffer)) return null;

  try {
    const payloadJson = Buffer.from(payloadBase64, 'base64url').toString('utf-8');
    const payload: TokenPayload = JSON.parse(payloadJson);

    // Verify expiration timestamp
    if (Date.now() > payload.expiresAt) {
      return null;
    }

    // Verify active user & token_version in SQLite (Instant revocation on logout)
    const user = db.getUserById(payload.userId);
    if (!user || user.token_version !== payload.tokenVersion) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

// Express Authentication Middleware
export function authenticateUserOrGuest(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  const guestHeader = (req.headers['x-guest-session-id'] as string) || '';

  let authContext: AuthContext = {
    userId: null,
    sessionId: guestHeader.trim() || 'default',
    isGuest: true,
    user: null,
  };

  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();

    if (token.startsWith('guest_')) {
      // Guest bearer token
      authContext = {
        userId: null,
        sessionId: token,
        isGuest: true,
        user: null,
      };
    } else {
      // Signed JWT / HMAC Teacher Token
      const verified = verifyToken(token);
      if (verified) {
        const user = db.getUserById(verified.userId);
        if (user) {
          authContext = {
            userId: user.id,
            sessionId: null,
            isGuest: false,
            user,
          };
        }
      } else {
        // Token was provided but is invalid or expired
        // If guest header was also provided, preserve guest context
        if (guestHeader) {
          authContext.sessionId = guestHeader;
        }
      }
    }
  } else if (authHeader && authHeader.startsWith('Guest ')) {
    const guestId = authHeader.slice(6).trim();
    if (guestId) {
      authContext = {
        userId: null,
        sessionId: guestId,
        isGuest: true,
        user: null,
      };
    }
  }

  req.auth = authContext;
  req.user = authContext.user;
  next();
}

// Require Teacher Auth Guard
export function requireTeacherAuth(req: Request, res: Response, next: NextFunction): void {
  if (req.auth.isGuest || !req.auth.userId || !req.auth.user) {
    res.status(401).json({ detail: 'Teacher authentication required for this operation.' });
    return;
  }
  next();
}
