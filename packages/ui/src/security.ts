import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";

/**
 * The guards of the local server (documentation/ui.md, "Security"): a per-session token on every request, a check of the Host and Origin
 * headers against DNS rebinding and cross-site requests, and the headers that tell the browser what a page may load. They run before
 * any route, so a request that fails one never reaches code that reads a run or starts a process.
 */

/** A fresh token: 256 random bits, URL-safe. */
export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

function digest(text: string): Buffer {
  return createHash("sha256").update(text).digest();
}

/** Whether `given` is the token, in constant time. */
export function tokenMatches(token: string, given: string | undefined): boolean {
  if (given === undefined || given === "") return false;
  return timingSafeEqual(digest(token), digest(given));
}

/** The Content-Security-Policy of every response: the page loads its own files and talks to its own server, nothing else. */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

export interface GuardOptions {
  token: string;
  /** The port the server listens on. */
  port: () => number;
  /** The host names the server answers to, besides its address (default `localhost`). */
  hostNames?: readonly string[];
}

/** The `Host` values a request to this server may carry. */
export function allowedHosts(port: number, extra: readonly string[] = ["localhost"]): Set<string> {
  return new Set([`127.0.0.1:${port}`, ...extra.map((h) => `${h}:${port}`)]);
}

/** Headers on every response, whatever the route or the failure. */
export const securityHeaders: MiddlewareHandler = async (c, next) => {
  await next();
  c.header("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "no-referrer");
  c.header("Cache-Control", "no-store");
  c.header("Cross-Origin-Opener-Policy", "same-origin");
  c.header("Cross-Origin-Resource-Policy", "same-origin");
  c.header("X-Frame-Options", "DENY");
};

const SAFE = new Set(["GET", "HEAD"]);

/**
 * The checks, in order. A failure is a plain-text answer with no detail an attacker could use:
 * 1. `Host` must be this server's address and port (a DNS-rebound name carries the attacker's host name);
 * 2. `Origin`, when present, must be this server's own origin, and a request that changes anything must carry one (or, from a browser that
 *    sends none, `Sec-Fetch-Site: same-origin`) and the header `X-Seshat-Request: 1`;
 * 3. every route under `/api/` needs the token, as `Authorization: Bearer`. There is no cookie: a cookie is sent to every service on
 *    127.0.0.1 whatever its port, and a second instance would overwrite it. The page's own files, which hold nothing of any run, are served
 *    to a request that passes 1 and 2; the token is in the fragment of the address `harness ui` prints, which no browser sends.
 */
export function guard(o: GuardOptions): MiddlewareHandler {
  return async (c, next) => {
    const hosts = allowedHosts(o.port(), o.hostNames);
    const host = c.req.header("host");
    if (host === undefined || !hosts.has(host.toLowerCase())) return c.text("Bad Host header.", 403);

    const origin = c.req.header("origin");
    if (origin !== undefined) {
      const ok = [...hosts].some((h) => origin === `http://${h}`);
      if (!ok) return c.text("Bad Origin header.", 403);
    } else if (!SAFE.has(c.req.method)) {
      if (c.req.header("sec-fetch-site") !== "same-origin") return c.text("A request that changes something must say where it comes from.", 403);
    }
    if (!SAFE.has(c.req.method) && c.req.header("x-seshat-request") !== "1") return c.text("Missing request header.", 403);

    const path = new URL(c.req.url).pathname;
    if (path.startsWith("/api/") || !SAFE.has(c.req.method)) {
      const bearer = /^Bearer (.+)$/.exec(c.req.header("authorization") ?? "")?.[1];
      if (!tokenMatches(o.token, bearer)) return c.text("Missing or bad token. Open the address `harness ui` printed.", 401);
    }
    await next();
  };
}
