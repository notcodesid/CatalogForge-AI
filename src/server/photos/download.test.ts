import { readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { downloadPhoto, isPrivateAddress } from "./download";
import { MAX_PHOTO_BYTES } from "./upload";

const jpeg = readFileSync("samples/test-files/09-photos/photos/TC-PL-20.jpg");
let base = "";
let busyCalls = 0;

// A small website on this machine with every kind of answer a photo link can get
const server = http.createServer((req, res) => {
  const send = (status: number, body: Buffer | string = "", headers: http.OutgoingHttpHeaders = {}) => res.writeHead(status, headers).end(body);
  switch (req.url) {
    case "/photo.jpg":
      return send(200, jpeg, { "content-type": "image/jpeg" });
    case "/moved":
      return send(302, "", { location: "/photo.jpg" });
    case "/loop":
      return send(302, "", { location: "/loop" });
    case "/busy-then-fine":
      return ++busyCalls <= 2 ? send(503) : send(200, jpeg);
    case "/always-busy":
      return send(503);
    case "/huge":
      return send(200, Buffer.alloc(MAX_PHOTO_BYTES + 1));
    default:
      return send(404, "not here");
  }
});

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

// Only the test website is on a private address, so the tests have to allow it
const allowed = { allowPrivateAddresses: true, retryDelaysMs: [0, 0] };

describe("isPrivateAddress", () => {
  it("knows this machine, private networks and cloud metadata from the public internet", () => {
    for (const address of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.10", "169.254.169.254", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
    for (const address of ["8.8.8.8", "172.32.0.1", "151.101.1.1", "2606:4700::1111"]) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
  });
});

describe("downloadPhoto", () => {
  it("never reaches this machine or the private network from a sheet's link", async () => {
    for (const link of [`${base}/photo.jpg`, `http://localhost:${new URL(base).port}/photo.jpg`, "http://169.254.169.254/latest/meta-data/", "http://[::1]/"]) {
      expect(await downloadPhoto(link, { retryDelaysMs: [] }), link).toEqual({
        ok: false,
        reason: "The link points to a private or local address, which isn't allowed",
        temporary: false,
      });
    }
    expect(await downloadPhoto("file:///etc/passwd")).toMatchObject({ ok: false, reason: "Only http and https links can be downloaded" });
  });

  it("downloads a photo, following a redirect", async () => {
    expect(await downloadPhoto(`${base}/photo.jpg`, allowed)).toEqual({ ok: true, bytes: jpeg });
    expect(await downloadPhoto(`${base}/moved`, allowed)).toEqual({ ok: true, bytes: jpeg });
  });

  it("tries a busy website again, and gives up after three tries", async () => {
    expect(await downloadPhoto(`${base}/busy-then-fine`, allowed)).toEqual({ ok: true, bytes: jpeg });
    expect(await downloadPhoto(`${base}/always-busy`, allowed)).toEqual({
      ok: false,
      reason: "The website answered 503 Service Unavailable (tried 3 times)",
      temporary: true,
    });
  });

  it("gives up straight away on a missing page, a redirect loop and a file that's too big", async () => {
    expect(await downloadPhoto(`${base}/missing.jpg`, allowed)).toEqual({ ok: false, reason: "The link answered 404 Not Found", temporary: false });
    expect(await downloadPhoto(`${base}/loop`, allowed)).toMatchObject({ ok: false, reason: "More than 3 redirects" });
    expect(await downloadPhoto(`${base}/huge`, allowed)).toMatchObject({ ok: false, reason: "The photo behind the link is bigger than the 20 MB limit" });
  });
});
