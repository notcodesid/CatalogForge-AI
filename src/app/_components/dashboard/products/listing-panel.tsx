import type { ReactNode } from "react";
import { formatPrice } from "../format";
import { Badge } from "../ui";
import type { ProductDetail } from "./api";
import { ConfidenceBadge } from "./bits";
import { fieldConfidence, humanize } from "./view";

// The right half of the review screen: the listing as the AI wrote it (or as the merchant edited it), each field
// with how sure the AI was, every claim with the exact words it came from, and the variants with their prices
export function ListingPanel({ product }: { product: ProductDetail }) {
  const edited = new Set(product.editedFields);
  const attributes = Object.entries(product.attributes);
  return (
    <section aria-labelledby="listing-heading" className="space-y-5 rounded-lg border border-border bg-card p-4 md:p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="listing-heading" className="text-base font-semibold">
          The listing
        </h2>
        {product.model && (
          <p className="text-xs text-muted-foreground">
            Written by {product.model}
            {product.promptVersion ? ` (${product.promptVersion})` : ""}
          </p>
        )}
      </div>

      <Field label="Title" confidence={fieldConfidence(product.confidence, "title")} edited={edited.has("title")}>
        <p className="font-medium">{product.title}</p>
      </Field>

      <Field label="Description" confidence={fieldConfidence(product.confidence, "description")} edited={edited.has("descriptionHtml")}>
        {product.descriptionHtml ? (
          // Cleaned on the server like supplier HTML: only p, ul, ol, li, strong, em, no attributes
          <div className="space-y-2 text-sm [&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:list-disc [&_ul]:pl-5" dangerouslySetInnerHTML={{ __html: product.descriptionHtml }} />
        ) : (
          <p className="text-sm text-muted-foreground">No description</p>
        )}
      </Field>

      <Field label="Category" confidence={fieldConfidence(product.confidence, "category")} edited={edited.has("category")}>
        <p className="text-sm">{product.category ?? <span className="text-muted-foreground">None</span>}</p>
      </Field>

      <Field label="Tags" confidence={fieldConfidence(product.confidence, "tags")} edited={edited.has("tags")}>
        {product.tags.length ? (
          <ul className="flex flex-wrap gap-1.5">
            {product.tags.map((tag) => (
              <li key={tag}>
                <Badge tone="neutral">{tag}</Badge>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No tags</p>
        )}
      </Field>

      <Field label="Attributes" edited={edited.has("attributes")}>
        {attributes.length ? (
          <dl className="divide-y divide-border rounded-md border border-border text-sm">
            {attributes.map(([key, value]) => (
              <div key={key} className="flex flex-wrap items-baseline justify-between gap-2 px-3 py-1.5">
                <dt className="text-muted-foreground">{humanize(key)}</dt>
                <dd className="flex items-baseline gap-2">
                  <span>{value}</span>
                  <ConfidenceBadge value={fieldConfidence(product.confidence, `attributes.${key}`)} label={key} />
                </dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="text-sm text-muted-foreground">No attributes</p>
        )}
      </Field>

      <Field label="Claims">
        {product.claims.length ? (
          <ul className="space-y-2">
            {product.claims.map((claim, i) => (
              <li key={i} className="rounded-md border border-border p-3 text-sm">
                <p className="font-medium">{claim.text}</p>
                <p className="mt-1 text-xs text-muted-foreground">From {claim.source}</p>
                <blockquote className="mt-2 border-l-2 border-border pl-3 text-sm italic">“{claim.quote}”</blockquote>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No quality claims (frost-proof, organic, handmade…) in this listing</p>
        )}
      </Field>

      <Field label="Variants">
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full min-w-[420px] text-left text-sm">
            <thead className="bg-muted text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="px-3 py-1.5 font-medium">SKU</th>
                <th scope="col" className="px-3 py-1.5 font-medium">Options</th>
                <th scope="col" className="px-3 py-1.5 font-medium">Price</th>
                <th scope="col" className="px-3 py-1.5 font-medium">Weight</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {product.variants.map((v) => (
                <tr key={v.id}>
                  <td className="px-3 py-1.5 font-mono text-xs">{v.sku}</td>
                  <td className="px-3 py-1.5">
                    {Object.entries(v.options)
                      .map(([name, value]) => `${humanize(name)}: ${value}`)
                      .join(" · ") || <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="px-3 py-1.5 tabular-nums">{formatPrice(v.priceCents, v.currency) ?? <span className="font-medium text-danger">No price</span>}</td>
                  <td className="px-3 py-1.5 tabular-nums text-muted-foreground">{v.weightGrams !== null ? `${v.weightGrams.toLocaleString("en")} g` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {product.variants.some((v) => v.priceCents === null) && (
          <p className="text-xs text-danger">A variant without a price can&apos;t be sold, so the product can&apos;t be approved until the sheet has it.</p>
        )}
      </Field>
    </section>
  );
}

function Field({ label, confidence, edited, children }: { label: string; confidence?: number | null; edited?: boolean; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</h3>
        {confidence !== undefined && <ConfidenceBadge value={confidence} label={label.toLowerCase()} />}
        {edited && <Badge tone="info">Edited by you</Badge>}
      </div>
      {children}
    </div>
  );
}
