import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { z } from "zod";
import type { Db } from "@/server/db/client";
import { products, translations, translationState, variants } from "@/server/db/schema";
import { checkField, cleanTranslated } from "./checks";
import { encodeValue, englishFields, fieldHashes, isLocale, isTranslatedField, LOCALES, type Locale, type TranslatedField, TRANSLATED_FIELDS } from "./fields";
import { enabledLocales } from "./languages";
import { localizeProduct, type TranslationRow } from "./localize";
import { enqueuePendingTranslations, markPending, noteEnglishChange } from "./state";

// A request the merchant can fix (unknown product, wrong shape...). The message is shown as is
export class TranslationEditError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

const label = z.string().trim().min(1).max(200);
const valueSchemas: Record<TranslatedField, z.ZodType> = {
  title: z.string().trim().min(1).max(200),
  description_html: z.string().trim().min(1).max(20_000),
  tags: z.array(z.string().trim().min(1).max(60)).min(1).max(20),
  attributes: z.record(z.string(), z.object({ label, value: z.string().trim().min(1).max(500) })),
  options: z.record(z.string(), z.object({ label, values: z.record(z.string(), z.string().trim().min(1).max(200)) })),
};

async function loadProduct(db: Db, productId: string) {
  const [product] = await db.select().from(products).where(and(eq(products.id, productId), isNull(products.deletedAt)));
  if (!product) throw new TranslationEditError("Product not found", 404);
  const productVariants = await db.select({ options: variants.options }).from(variants).where(eq(variants.productId, productId));
  return { product, english: englishFields(product, productVariants), variants: productVariants };
}

function checkTarget(locale: string, field: string): { locale: Locale; field: TranslatedField } {
  if (!isLocale(locale)) throw new TranslationEditError(`Unknown language "${locale}". Use ${LOCALES.join(" or ")}`, 404);
  if (!isTranslatedField(field)) throw new TranslationEditError(`Unknown field "${field}". Use ${TRANSLATED_FIELDS.join(", ")}`, 404);
  return { locale, field };
}

// The merchant writes a translation by hand. It's used from now on, the AI never overwrites it, and if the English
// changes later it's kept and shown as out of date. Our checks still run, as warnings: the merchant decides
export async function writeTranslation(db: Db, productId: string, localeParam: string, fieldParam: string, value: unknown) {
  const { locale, field } = checkTarget(localeParam, fieldParam);
  const parsed = valueSchemas[field].safeParse(value);
  if (!parsed.success) throw new TranslationEditError(`The value for ${field} isn't valid: ${z.prettifyError(parsed.error)}`);

  await noteEnglishChange(db, productId);
  const { english } = await loadProduct(db, productId);
  if (english[field] === undefined) throw new TranslationEditError(`This product has no English ${field} to translate`, 409);
  const cleaned = cleanTranslated(field, english, { [field]: parsed.data });
  const warnings = checkField(field, english, { [field]: cleaned });
  const values = { value: encodeValue(cleaned), sourceHash: fieldHashes(english)[field], writtenBy: "merchant" as const, issue: null, updatedAt: new Date() };
  await db
    .insert(translations)
    .values({ productId, locale, field, ...values })
    .onConflictDoUpdate({ target: [translations.productId, translations.locale, translations.field], set: values });
  return { field, locale, value: cleaned, warnings };
}

// The English changed, the merchant checked their translation and it's still right: it's no longer out of date
export async function confirmTranslation(db: Db, productId: string, localeParam: string, fieldParam: string) {
  const { locale, field } = checkTarget(localeParam, fieldParam);
  const { english } = await loadProduct(db, productId);
  const hash = fieldHashes(english)[field];
  const updated = await db
    .update(translations)
    .set({ sourceHash: hash })
    .where(and(eq(translations.productId, productId), eq(translations.locale, locale), eq(translations.field, field), eq(translations.writtenBy, "merchant")))
    .returning({ field: translations.field });
  if (!updated.length) throw new TranslationEditError("There's no translation of yours to confirm for this field", 404);
  return { field, locale, outOfDate: false };
}

// The merchant drops their own translation: the AI translates that field again
export async function revertToAi(db: Db, boss: PgBoss, productId: string, localeParam: string, fieldParam: string) {
  const { locale, field } = checkTarget(localeParam, fieldParam);
  await loadProduct(db, productId);
  await db
    .delete(translations)
    .where(and(eq(translations.productId, productId), eq(translations.locale, locale), eq(translations.field, field), eq(translations.writtenBy, "merchant")));
  if ((await enabledLocales(db)).includes(locale)) {
    await markPending(db, [productId], [locale]);
    await enqueuePendingTranslations(db, boss, { productIds: [productId] });
  }
  return { field, locale, writtenBy: "ai" as const, status: "pending" as const };
}

// Everything about a product's translations, for the review screen: the English, and per language each field's
// translation (who wrote it, its problem, out of date or not), the translation state, and what shoppers see
export async function productTranslations(db: Db, productId: string) {
  const { product, english, variants: productVariants } = await loadProduct(db, productId);
  const hashes = fieldHashes(english);
  const [rows, states, enabled] = await Promise.all([
    db.select().from(translations).where(eq(translations.productId, productId)).orderBy(asc(translations.field)),
    db.select().from(translationState).where(and(eq(translationState.productId, productId), inArray(translationState.locale, [...LOCALES]))),
    enabledLocales(db),
  ]);
  return {
    productId,
    title: product.title,
    english,
    languages: LOCALES.map((locale) => {
      const mine = rows.filter((r) => r.locale === locale);
      const state = states.find((s) => s.locale === locale);
      return {
        locale,
        // Shown to shoppers in some country right now
        enabled: enabled.includes(locale),
        status: state?.status ?? null,
        error: state?.error ?? null,
        fields: Object.fromEntries(
          mine.map((r) => [
            r.field,
            {
              value: r.value,
              writtenBy: r.writtenBy,
              issue: r.issue,
              // Made from the current English
              upToDate: r.sourceHash === hashes[r.field],
              outOfDate: r.writtenBy === "merchant" && r.sourceHash !== hashes[r.field],
            },
          ]),
        ),
        shown: localizeProduct(product, productVariants, mine as TranslationRow[], locale),
      };
    }),
  };
}
