import { z } from "zod";

// What the AI must send back for each product. Anything that doesn't match this shape is rejected and retried

const confidence = z.number().min(0).max(100);

const productDraftSchema = z.object({
  // The product key we sent, so answers can be matched to products
  key: z.string().min(1),
  title: z.string().max(200),
  description_html: z.string().max(10_000),
  category: z.string().max(200),
  tags: z.array(z.string().max(60)).max(20),
  attributes: z.record(z.string(), z.string().max(300)),
  // What the supplier's colour or size column really holds, when it isn't one: { "color": "scent" }. Checked in verify.ts
  option_names: z.record(z.string(), z.string().max(100)).nullish(),
  claims: z
    .array(
      z.object({
        // The claim in plain English, e.g. "frost-resistant"
        text: z.string().min(1).max(200),
        // Where it comes from: row number and column name of the supplier's sheet
        row: z.number().int(),
        column: z.string(),
        // The supplier's exact words, copied character for character
        quote: z.string().min(1).max(500),
      }),
    )
    .max(20),
  // Field name -> 0..100. Keys: title, description, category, tags, and attributes.<name>
  confidence: z.record(z.string(), confidence),
  needs_review: z.boolean(),
  review_reason: z.string().max(500).nullable(),
});

export const buildResponseSchema = z.object({ products: z.array(productDraftSchema) });

export type ProductDraft = z.infer<typeof productDraftSchema>;

// JSON Schema version, for providers that can force their answer into a shape
export const buildResponseJsonSchema = z.toJSONSchema(buildResponseSchema);
