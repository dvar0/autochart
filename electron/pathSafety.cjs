const path = require("path");

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

function safeFolderName(value, fallback = "song") {
  let name = String(value || fallback)
    .replace(/[\x00-\x1f<>:"/\\|?*%]/g, "_")
    .trim()
    .replace(/[ .]+$/g, "");
  if (!name || name === "." || name === "..") name = fallback;
  if (WINDOWS_RESERVED.test(name)) name = `_${name}`;
  name = name.replace(/[ .]+$/g, "");
  return name && name !== "." && name !== ".." ? name : "song";
}

function strictFileName(value, label = "file") {
  const name = String(value || "");
  if (
    !name ||
    name === "." ||
    name === ".." ||
    path.isAbsolute(name) ||
    path.basename(name) !== name ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\0")
  ) {
    throw new Error(`Invalid ${label} name.`);
  }
  return name;
}

function isStrictChild(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}
function strictChildPath(parent, name, fallback = "song") {
  const root = path.resolve(parent);
  const child = path.resolve(root, safeFolderName(name, fallback));
  if (!isStrictChild(root, child) || path.dirname(child) !== root) {
    throw new Error("Resolved path must be a strict child of its parent.");
  }
  return child;
}

module.exports = { isStrictChild, safeFolderName, strictChildPath, strictFileName };
