import { customAlphabet } from 'nanoid';

const URL_SAFE_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const IDENTIFIER_LENGTH = 10;

const nanoid = customAlphabet(URL_SAFE_ALPHABET, IDENTIFIER_LENGTH);

// Derived from the same alphabet/length nanoid is configured with above, so this can
// never drift out of sync with what generateIdentifier() actually produces.
export const IDENTIFIER_PATTERN = new RegExp(`^[${URL_SAFE_ALPHABET}]{${IDENTIFIER_LENGTH}}$`);

export function generateIdentifier(): string {
  return nanoid();
}
