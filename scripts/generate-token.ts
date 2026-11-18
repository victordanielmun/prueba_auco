/**
 * Genera un JWT HS256 de desarrollo firmado con JWT_SECRET (.env).
 * Uso: npm run token -- [subject] [expiresIn]
 */
import 'dotenv/config';
import jwt from 'jsonwebtoken';

const secret = process.env.JWT_SECRET;
if (!secret) {
  console.error('JWT_SECRET is not set (check your .env file)');
  process.exit(1);
}

const subject = process.argv[2] ?? 'dev-user';
const expiresIn = (process.argv[3] ?? process.env.JWT_EXPIRES_IN ?? '1h') as jwt.SignOptions['expiresIn'];

console.log(jwt.sign({ sub: subject }, secret, { algorithm: 'HS256', expiresIn }));
