import { z } from "zod";
import { getDb } from "@/server/db/client";
import { getApiBoss } from "@/server/queue/boss";
import { LanguageSettingError, setCountryEnabled } from "@/server/translations/settings";
import { revalidateStorefront } from "@/server/storefront/revalidate";

const bodySchema = z.object({ enabled: z.boolean() });

// PUT /api/settings/languages/:country  { "enabled": true }
// Switches a country's language on or off. Switching on a language no country showed yet translates the catalog
// into it, in the background
export async function PUT(request: Request, ctx: RouteContext<"/api/settings/languages/[country]">) {
  const { country } = await ctx.params;
  const body = bodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return Response.json({ error: 'Send JSON: { "enabled": true } or { "enabled": false }' }, { status: 400 });
  try {
    const result = await setCountryEnabled(getDb(), await getApiBoss(), country, body.data.enabled);
    // What shoppers see changed: the storefront shows it now instead of within a minute
    revalidateStorefront();
    return Response.json(result);
  } catch (err) {
    if (err instanceof LanguageSettingError) return Response.json({ error: err.message }, { status: err.status });
    console.error("[api] changing a country's language failed", err);
    return Response.json({ error: "Something went wrong. Try again" }, { status: 500 });
  }
}
