/**
 * No-op stub for `basic-ftp`.
 *
 * The real package is blocked by Replit's Socket package firewall. It is only
 * pulled in transitively (apify-client → proxy-agent → pac-proxy-agent →
 * get-uri → basic-ftp) to resolve ftp:// URLs, which this app never does.
 *
 * get-uri's ftp handler does `const { Client } = require('basic-ftp')` at load
 * time and only calls `new Client()` when fetching an ftp:// URI. We expose a
 * matching surface so the require() succeeds; if it were ever instantiated it
 * throws a clear error instead of silently misbehaving.
 */
class Client {
  constructor() {
    throw new Error(
      'basic-ftp is stubbed out (ftp:// is not supported in this deployment).'
    );
  }
}

class FileInfo {}
class StringEncoding {}
const FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 3 };

module.exports = { Client, FileInfo, FileType, StringEncoding };
