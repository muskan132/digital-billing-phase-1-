import * as fs from 'fs';
import * as path from 'path';
import { config } from 'dotenv';
import { computeSecureHash } from '../src/callbacks/secure-hash.util';

config({ path: path.join(__dirname, '..', '.env') });

const secretKey = process.env.SECRET_KEY;
if (!secretKey) {
  throw new Error('SECRET_KEY env var is required to sign a fixture');
}

const fixtureArg = process.argv[2] ?? 'sample.json';
const fixturePath = path.isAbsolute(fixtureArg) ? fixtureArg : path.join(__dirname, '..', fixtureArg);

const payload = JSON.parse(fs.readFileSync(fixturePath, 'utf-8'));
payload.secureHash = computeSecureHash(payload, Buffer.from(secretKey, 'utf-8'));
fs.writeFileSync(fixturePath, JSON.stringify(payload, null, 3) + '\n');
console.log(`${fixtureArg} re-signed`);
