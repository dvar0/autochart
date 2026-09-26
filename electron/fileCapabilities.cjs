const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");

const DEFAULT_TTL_MS = 5 * 60 * 1000;

class FileCapabilityRegistry {
  constructor({ ttlMs = DEFAULT_TTL_MS, now = () => Date.now() } = {}) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.bySender = new WeakMap();
  }

  async register(sender, filePath, metadata = {}) {
    if (!sender || typeof sender !== "object") throw new Error("File capability sender is required.");
    const raw = String(filePath || "").trim();
    if (!raw) throw new Error("Selected file has no filesystem path.");
    const canonicalPath = await fs.realpath(path.resolve(raw));
    const stat = await fs.lstat(canonicalPath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error("Selected generation input must be a real regular file.");
    }
    let entries = this.bySender.get(sender);
    if (!entries) {
      entries = new Map();
      this.bySender.set(sender, entries);
      sender.once?.("destroyed", () => this.clear(sender));
    }
    const token = crypto.randomUUID();
    const expiresAt = this.now() + this.ttlMs;
    entries.set(token, {
      path: canonicalPath,
      name: path.basename(canonicalPath),
      mime: String(metadata.mime || "application/octet-stream"),
      purpose: String(metadata.purpose || ""),
      size: stat.size,
      lastModified: stat.mtimeMs,
      device: stat.dev,
      inode: stat.ino,
      expiresAt,
    });
    return { token, expiresAt };
  }

  async consume(sender, token, { purpose = "" } = {}) {
    const entries = sender && this.bySender.get(sender);
    const key = String(token || "");
    const entry = entries?.get(key);
    if (!entry) throw new Error("Unknown or sender-mismatched file capability.");
    entries.delete(key);
    if (entry.expiresAt < this.now()) throw new Error("File capability expired.");
    if (purpose && entry.purpose !== purpose) {
      throw new Error("File capability is not valid for this operation.");
    }
    const stat = await fs.lstat(entry.path);
    if (
      stat.isSymbolicLink() ||
      !stat.isFile() ||
      stat.dev !== entry.device ||
      stat.ino !== entry.inode ||
      stat.size !== entry.size ||
      stat.mtimeMs !== entry.lastModified ||
      await fs.realpath(entry.path) !== entry.path
    ) {
      throw new Error("Selected file changed after capability registration.");
    }
    return entry;
  }

  clear(sender) {
    if (sender) this.bySender.delete(sender);
  }
}

module.exports = { DEFAULT_TTL_MS, FileCapabilityRegistry };
