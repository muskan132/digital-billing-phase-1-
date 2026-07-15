import { customAlphabet } from 'nanoid';

const URL_SAFE_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const IDENTIFIER_LENGTH = 10;

const nanoid = customAlphabet(URL_SAFE_ALPHABET, IDENTIFIER_LENGTH);

export function generateIdentifier(): string {
  return nanoid();
}
