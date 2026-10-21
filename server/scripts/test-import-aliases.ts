// Fails when a module import in src/ or scripts/ uses a relative path.
// Server modules are imported as "@/..." and scripts as "@scripts/..."
// (paths in tsconfig.json, rewritten in dist/ by tsc-alias).
import assert = require("assert");
import fs = require("fs");
import path = require("path");

const SERVER_DIR = path.resolve(__dirname, "..");
const RELATIVE_SPECIFIER =
  /(?:\bfrom\s+|\bimport\s+|\bimport\(\s*|\brequire\(\s*)(["'])(\.\.?\/[^"']*)\1/g;

function tsFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return tsFiles(full);
    return entry.name.endsWith(".ts") ? [full] : [];
  });
}

const offenders: string[] = [];
for (const file of [...tsFiles(path.join(SERVER_DIR, "src")), ...tsFiles(path.join(SERVER_DIR, "scripts"))]) {
  const lines = fs.readFileSync(file, "utf8").split("\n");
  lines.forEach((line, index) => {
    for (const match of line.matchAll(RELATIVE_SPECIFIER)) {
      offenders.push(`${path.relative(SERVER_DIR, file)}:${index + 1}: ${match[2]}`);
    }
  });
}

assert.deepStrictEqual(offenders, [], `relative module imports found:\n${offenders.join("\n")}`);
console.log("ok   no relative module imports in src/ and scripts/");
