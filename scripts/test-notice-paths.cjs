#!/usr/bin/env node
"use strict";

const assert = require("assert/strict");
const path = require("path");
const { NOTICE_FILES, resolveNoticePath } = require("../electron/noticePaths.cjs");

const appRoot = path.resolve(__dirname, "..");
for (const [key, relative] of Object.entries(NOTICE_FILES)) {
  const resolved = resolveNoticePath(appRoot, key);
  assert.equal(resolved, path.join(appRoot, relative));
  assert.equal(path.relative(appRoot, resolved).startsWith(".."), false);
}
assert.throws(() => resolveNoticePath(appRoot, "../../etc/passwd"), /Unknown Autochart notice/);
assert.throws(() => resolveNoticePath(appRoot, ""), /Unknown Autochart notice/);
console.log("notice path safety checks passed");
