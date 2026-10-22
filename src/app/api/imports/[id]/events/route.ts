import { connection } from "next/server";
import { z } from "zod";
import { getDb } from "@/server/db/client";
import { getImportSummary } from "@/server/imports/queries";

// How often the summary is read while the import runs, and how long one stream stays open. The browser's
// EventSource reconnects by itself after a stream ends, so long imports are followed without one stream
// holding a connection for an hour
const TICK_MS = 1_000;
const MAX_STREAM_MS = 5 * 60_000;
const HEARTBEAT_MS = 15_000;

// GET /api/imports/:id/events - live progress as Server-Sent Events. Sends the summary (same as
// GET /api/imports/:id) whenever it changes, then "end" once the import is done or failed
export async function GET(request: Request, ctx: RouteContext<"/api/imports/[id]/events">) {
  await connection();
  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return Response.json({ error: "Import not found" }, { status: 404 });
  const db = getDb();
  const first = await getImportSummary(db, id);
  if (!first) return Response.json({ error: "Import not found" }, { status: 404 });

  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const started = Date.now();
      let last = "";
      let lastSent = 0;
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        clearTimeout(timer);
        try {
          controller.close();
        } catch {
          // Already closed by the browser going away
        }
      };
      const send = (text: string) => {
        if (closed) return;
        controller.enqueue(encoder.encode(text));
        lastSent = Date.now();
      };
      request.signal.addEventListener("abort", close);

      const tick = async (summary: Awaited<ReturnType<typeof getImportSummary>>) => {
        if (closed) return;
        if (!summary) {
          send(`event: gone\ndata: {}\n\n`);
          return close();
        }
        const json = JSON.stringify(summary);
        if (json !== last) {
          send(`event: summary\ndata: ${json}\n\n`);
          last = json;
        } else if (Date.now() - lastSent > HEARTBEAT_MS) {
          // A comment line keeps proxies from closing a quiet connection
          send(`: still running\n\n`);
        }
        if (summary.status === "done" || summary.status === "failed") {
          send(`event: end\ndata: {}\n\n`);
          return close();
        }
        if (Date.now() - started > MAX_STREAM_MS) return close();
        timer = setTimeout(() => {
          getImportSummary(db, id)
            .then(tick)
            .catch(() => close());
        }, TICK_MS);
      };
      // Reconnect after a second if the stream drops
      send(`retry: 1000\n\n`);
      void tick(first);
    },
    cancel() {
      clearTimeout(timer);
    },
  });

  return new Response(stream, {
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive" },
  });
}
