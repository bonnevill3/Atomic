// Creates the hot wallet's recovery phrase on the server itself. Refuses to overwrite an existing one.
// Usage: tsx scripts/new-mnemonic.ts <file>
import { writeFileSync } from "node:fs";
import { generateMnemonic, validateMnemonic } from "bip39";

const file = process.argv[2];
if (!file) throw new Error("usage: tsx scripts/new-mnemonic.ts <file>");
const words = generateMnemonic(256); // 24 words from the OS random source
if (!validateMnemonic(words)) throw new Error("generated an invalid mnemonic");
// "wx": fail if the file exists (never replace keys that may hold funds); 0600: only the owner can read it
writeFileSync(file, `${words}\n`, { flag: "wx", mode: 0o600 });
console.log(`created ${file}`);
