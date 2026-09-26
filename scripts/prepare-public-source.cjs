#!/usr/bin/env node
"use strict";

// Copy only the reviewed files. No Git history, directory recursion, installs,
// model reads, or modifications to the working app/profile are performed.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = fs.realpathSync(path.resolve(__dirname, ".."));
const MANIFEST = "config/public-source-files.json";
const digest = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

function sourceFile(relative) {
  if (typeof relative !== "string" || !relative || relative.includes("\\") ||
      path.posix.isAbsolute(relative) || relative.split("/").some((part) =>
        !part || part === "." || part === ".." || part === ".git" || part === "node_modules")) {
    throw new Error(`Invalid source path: ${relative}`);
  }
  let current = ROOT;
  const parts = relative.split("/");
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) {
      throw new Error(`Source must be an ordinary file with no symlink parents: ${relative}`);
    }
  }
  return current;
}

function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0] === "--help") {
    console.log("Usage: node scripts/prepare-public-source.cjs /new/review-directory");
    console.log("Creates source/ and a private review.json; refuses an existing destination.");
    if (args[0] !== "--help") process.exitCode = 1;
    return;
  }
  const requested = path.resolve(args[0]);
  const parent = fs.realpathSync(path.dirname(requested));
  const destination = path.join(parent, path.basename(requested));
  const relation = path.relative(ROOT, destination);
  if (!relation || (!relation.startsWith(`..${path.sep}`) && !path.isAbsolute(relation))) {
    throw new Error("Choose a destination outside the source checkout.");
  }
  const manifestBytes = fs.readFileSync(sourceFile(MANIFEST));
  const manifest = JSON.parse(manifestBytes);
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files) || !manifest.files.length) {
    throw new Error("Invalid public source manifest.");
  }
  if (new Set(manifest.files.map((file) => file.toLowerCase())).size !== manifest.files.length) {
    throw new Error("Duplicate or case-colliding public source paths.");
  }
  const entries = manifest.files.map((relative) => {
    const file = sourceFile(relative);
    const bytes = fs.readFileSync(file);
    return { relative, bytes, mode: fs.statSync(file).mode & 0o777 };
  });
  // Exclusive creation: never merge into or erase an existing snapshot.
  fs.mkdirSync(destination);
  const sourceRoot = path.join(destination, "source");
  fs.mkdirSync(sourceRoot);
  const files = [];
  for (const entry of entries) {
    const target = path.join(sourceRoot, entry.relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entry.bytes, { flag: "wx", mode: entry.mode });
    const sha256 = digest(entry.bytes);
    if (digest(fs.readFileSync(target)) !== sha256) throw new Error(`Copy mismatch: ${entry.relative}`);
    files.push({ path: entry.relative, bytes: entry.bytes.length, sha256 });
  }
  fs.writeFileSync(path.join(destination, "review.json"), JSON.stringify({
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    manifestSha256: digest(manifestBytes),
    files,
    notes: [
      "Only source/ is a candidate public repository. Keep this review record outside it.",
      "No Git history, author identity, remote, commit, tag, or publication was created.",
      "Byte checks establish copying integrity, not secret-scan or release certification.",
      "Review the candidate, then build public artifacts from its own clean tagged commit."
    ]
  }, null, 2) + "\n", { flag: "wx" });
  console.log(`Prepared ${files.length} files in ${sourceRoot}`);
  console.log(`Private file hashes: ${path.join(destination, "review.json")}`);
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
