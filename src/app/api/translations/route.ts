import { connection } from "next/server";
import { getDb } from "@/server/db/client";
import { translationCoverage } from "@/server/translations/coverage";

// GET /api/translations - translation coverage of the catalog per language, and how many of the merchant's own
// translations are out of date
export async function GET() {
  await connection();
  return Response.json(await translationCoverage(getDb()));
}
