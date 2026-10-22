import { connection } from "next/server";
import { getDb } from "@/server/db/client";
import { enabledLocales, listCountries } from "@/server/translations/languages";

// GET /api/settings/languages - which language each country's shoppers see. Countries not listed, or switched
// off, see English
export async function GET() {
  await connection();
  const db = getDb();
  return Response.json({ countries: await listCountries(db), languages: await enabledLocales(db) });
}
