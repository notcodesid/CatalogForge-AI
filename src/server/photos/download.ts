import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { MAX_PHOTO_BYTES } from "./upload";

// Downloads the photos a sheet links to (e.g. a Shopify export's "Image Src"). The links come from a file anyone
// can upload, so they're treated as hostile: only http(s), never an address on this machine or our network
// (that would let a sheet probe our database or a cloud's metadata service), a time limit, a size limit,
// and at most a few redirects, each checked again

const TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;
const RETRY_DELAYS_MS = [1_000, 3_000];
const USER_AGENT = "CatalogForge/1.0 (product photo import)";

export type Download = { ok: true; bytes: Buffer } | { ok: false; reason: string; temporary: boolean };
export type DownloadOptions = { allowPrivateAddresses?: boolean; retryDelaysMs?: number[] };

const blocked = new net.BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // this machine
  ["169.254.0.0", 16], // link-local, including cloud metadata (169.254.169.254)
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["224.0.0.0", 3], // multicast, reserved, broadcast
] as const) {
  blocked.addSubnet(address, prefix, "ipv4");
}
for (const [address, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7], // private
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
] as const) {
  blocked.addSubnet(address, prefix, "ipv6");
}

export function isPrivateAddress(address: string): boolean {
  // An IPv4 address written as IPv6 (::ffff:127.0.0.1) is checked as IPv4
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return isPrivateAddress(mapped[1]);
  const family = net.isIP(address);
  if (family === 4) return blocked.check(address, "ipv4");
  if (family === 6) return blocked.check(address, "ipv6");
  return true;
}

class Refused extends Error {
  constructor(
    message: string,
    readonly temporary = false,
  ) {
    super(message);
  }
}

const PRIVATE = "The link points to a private or local address, which isn't allowed";

// Name lookup that refuses private addresses. It runs when the connection is made, so a name that pointed
// somewhere public a moment ago can't switch to 127.0.0.1 in between (DNS rebinding)
const safeLookup: net.LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, "");
    if (!addresses.length || addresses.some((a) => isPrivateAddress(a.address))) {
      return callback(Object.assign(new Error(PRIVATE), { code: "EBLOCKED" }), "");
    }
    if (options.all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
};

type Answer = { status: number; location?: string; bytes?: Buffer };

function getOnce(url: URL, signal: AbortSignal, allowPrivate: boolean): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const client = url.protocol === "https:" ? https : http;
    const request = client.get(
      url,
      { signal, lookup: allowPrivate ? undefined : safeLookup, headers: { "user-agent": USER_AGENT, accept: "image/*" } },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status !== 200) {
          res.resume();
          return resolve({ status, location: res.headers.location });
        }
        const tooBig = new Refused(`The photo behind the link is bigger than the ${MAX_PHOTO_BYTES / 1024 / 1024} MB limit`);
        if (Number(res.headers["content-length"] ?? 0) > MAX_PHOTO_BYTES) {
          res.destroy();
          return reject(tooBig);
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_PHOTO_BYTES) {
            res.destroy();
            reject(tooBig);
          } else {
            chunks.push(chunk);
          }
        });
        res.on("end", () => resolve({ status, bytes: Buffer.concat(chunks) }));
        res.on("error", reject);
      },
    );
    request.on("error", reject);
  });
}

function describe(err: unknown): Refused {
  if (err instanceof Refused) return err;
  const e = err as { name?: string; code?: string; message?: string };
  if (e.code === "EBLOCKED") return new Refused(PRIVATE);
  if (e.name === "AbortError" || e.name === "TimeoutError" || e.code === "ABORT_ERR") return new Refused(`No answer within ${TIMEOUT_MS / 1000} seconds`, true);
  if (e.code === "ENOTFOUND") return new Refused("The website in this link doesn't exist");
  if (e.code === "EAI_AGAIN") return new Refused("The website's name couldn't be looked up right now", true);
  if (e.code?.startsWith("CERT_") || e.code?.includes("SELF_SIGNED") || e.code === "ERR_TLS_CERT_ALTNAME_INVALID") {
    return new Refused("The website's security certificate isn't valid");
  }
  return new Refused(`Couldn't connect (${e.code ?? e.message ?? "unknown error"})`, true);
}

async function downloadOnce(link: string, allowPrivate: boolean): Promise<Download> {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return { ok: false, reason: "This isn't a valid link", temporary: false };
  }
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Refused("Only http and https links can be downloaded");
      if (url.username || url.password) throw new Refused("Links with a user name or password aren't downloaded");
      // An address written as numbers skips the name lookup, so it's checked here
      const host = url.hostname.replace(/^\[|\]$/g, "");
      if (!allowPrivate && net.isIP(host) && isPrivateAddress(host)) throw new Refused(PRIVATE);

      const answer = await getOnce(url, signal, allowPrivate);
      if (answer.status >= 300 && answer.status < 400 && answer.location) {
        url = new URL(answer.location, url);
        continue;
      }
      if (answer.status === 429 || answer.status >= 500) throw new Refused(`The website answered ${answer.status} ${http.STATUS_CODES[answer.status] ?? ""}`.trim(), true);
      if (answer.status !== 200 || !answer.bytes) throw new Refused(`The link answered ${answer.status} ${http.STATUS_CODES[answer.status] ?? ""}`.trim());
      return { ok: true, bytes: answer.bytes };
    }
    throw new Refused(`More than ${MAX_REDIRECTS} redirects`);
  } catch (err) {
    const refused = describe(err);
    return { ok: false, reason: refused.message, temporary: refused.temporary };
  }
}

// Downloads a photo link. A timeout, a dropped connection or a busy server (5xx, 429) gets two more tries;
// a missing page, a private address or a file that's too big doesn't
export async function downloadPhoto(link: string, options: DownloadOptions = {}): Promise<Download> {
  const delays = options.retryDelaysMs ?? RETRY_DELAYS_MS;
  let result = await downloadOnce(link, options.allowPrivateAddresses ?? false);
  for (let i = 0; !result.ok && result.temporary && i < delays.length; i++) {
    await new Promise((r) => setTimeout(r, delays[i]));
    result = await downloadOnce(link, options.allowPrivateAddresses ?? false);
  }
  if (!result.ok && result.temporary) return { ...result, reason: `${result.reason} (tried ${delays.length + 1} times)` };
  return result;
}
