import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ErrorInput } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.resolve(__dirname, "../fixtures", process.argv[2] ?? "error1.json");

const raw = await readFile(fixturePath, "utf8");
const input = JSON.parse(raw) as ErrorInput;

console.log(`Loaded fixture: ${fixturePath}`);
console.log(input);
