"use client";

import Link from "next/link";
import { useState } from "react";
import { timeAgo } from "../format";
import { Badge, buttonClasses, linkClasses } from "../ui";
import { errorMessage, type ListingField, type NewVersion, type ProductDetail, sendJson } from "./api";
import { humanize } from "./view";

const FIELD_LABEL: Record<ListingField, string> = {
  title: "Title",
  descriptionHtml: "Description",
  category: "Category",
  tags: "Tags",
  attributes: "Attributes",
  optionNames: "Variant option names",
  claims: "Claims",
};
const FIELDS = Object.keys(FIELD_LABEL) as ListingField[];

type Listing = Pick<NewVersion, ListingField>;

// The AI wrote a new listing for this approved product (a newer sheet, or newer instructions). The shop keeps the
// current one until the merchant chooses: every field the new version changes is shown now and new side by side,
// with what the AI checks found in it
export function NewVersionPanel({
  product,
  disabled,
  onChanged,
  onError,
}: {
  product: ProductDetail;
  disabled: boolean;
  onChanged: (product: ProductDetail, message: string) => void;
  onError: (message: string) => void;
}) {
  const next = product.newVersion!;
  const [busy, setBusy] = useState(false);
  const approved = product.status === "approved";
  const same = FIELDS.filter((field) => !next.changes.includes(field));

  const act = async (method: "POST" | "DELETE", message: string) => {
    setBusy(true);
    try {
      const result = await sendJson<{ product: ProductDetail }>(method, `/api/products/${product.id}/new-version`);
      onChanged(result.product, message);
    } catch (err) {
      onError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="new-version-heading" className="space-y-4 rounded-lg border border-warning/40 bg-card p-4 md:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h2 id="new-version-heading" className="text-base font-semibold">
            A new version of the listing is waiting
          </h2>
          <p className="text-sm text-muted-foreground">
            Written by {next.model}
            {next.fromImport && (
              <>
                {" "}
                from{" "}
                <Link href={`/imports/${next.fromImport.id}`} className={linkClasses}>
                  {next.fromImport.fileName}
                </Link>
              </>
            )}{" "}
            · {timeAgo(next.createdAt)}. {approved ? "The shop shows the current one until you choose." : "Using it doesn't approve the product."}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={buttonClasses("primary")}
            disabled={busy || disabled}
            onClick={() => act("POST", approved ? "Using the new version. It's in the shop now, and its translations are being redone" : "Using the new version")}
          >
            Use the new version
          </button>
          <button type="button" className={buttonClasses("secondary")} disabled={busy || disabled} onClick={() => act("DELETE", "Kept the current listing. The same sheet uploaded again won't bring the new version back")}>
            Keep the current one
          </button>
        </div>
      </div>

      {next.reviewReasons.length > 0 && (
        <div className="rounded-md border border-warning/40 bg-warning-soft p-3">
          <h3 className="text-sm font-semibold text-warning">Check before using it</h3>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
            {next.reviewReasons.map((reason, i) => (
              <li key={i}>{reason}</li>
            ))}
          </ul>
        </div>
      )}

      {next.changes.length === 0 ? (
        <p className="text-sm text-muted-foreground">It reads the same as the current listing.</p>
      ) : (
        <dl className="space-y-4">
          {next.changes.map((field) => (
            <div key={field} className="space-y-1.5">
              <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{FIELD_LABEL[field]}</dt>
              {/* grid-cols-1, not the default: long text wraps in its box instead of widening the page */}
              <dd className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="min-w-0 space-y-1 rounded-md border border-border p-3">
                  <p className="text-xs font-medium text-muted-foreground">Now</p>
                  <FieldValue field={field} listing={product} />
                </div>
                <div className="min-w-0 space-y-1 rounded-md border border-warning/40 p-3">
                  <p className="text-xs font-medium text-warning">New</p>
                  <FieldValue field={field} listing={next} />
                </div>
              </dd>
            </div>
          ))}
        </dl>
      )}
      {next.changes.length > 0 && same.length > 0 && (
        <p className="text-xs text-muted-foreground">The same as now: {same.map((field) => FIELD_LABEL[field].toLowerCase()).join(", ")}.</p>
      )}
    </section>
  );
}

// One field of a listing, the way the listing panel shows it
function FieldValue({ field, listing }: { field: ListingField; listing: Listing }) {
  const none = (text: string) => <p className="text-sm text-muted-foreground">{text}</p>;
  switch (field) {
    case "title":
      return <p className="break-words font-medium">{listing.title}</p>;
    case "descriptionHtml":
      return listing.descriptionHtml ? (
        // Cleaned on the server like supplier HTML: only p, ul, ol, li, strong, em, no attributes
        <div className="space-y-2 break-words text-sm [&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:list-disc [&_ul]:pl-5" dangerouslySetInnerHTML={{ __html: listing.descriptionHtml }} />
      ) : (
        none("No description")
      );
    case "category":
      return listing.category ? <p className="text-sm">{listing.category}</p> : none("None");
    case "tags":
      return listing.tags.length ? (
        <ul className="flex flex-wrap gap-1.5">
          {listing.tags.map((tag) => (
            <li key={tag}>
              <Badge tone="neutral">{tag}</Badge>
            </li>
          ))}
        </ul>
      ) : (
        none("No tags")
      );
    case "attributes": {
      const attributes = Object.entries(listing.attributes);
      return attributes.length ? (
        <dl className="space-y-0.5 text-sm">
          {attributes.map(([key, value]) => (
            <div key={key} className="flex flex-wrap gap-x-2">
              <dt className="text-muted-foreground">{humanize(key)}</dt>
              <dd className="break-words">{value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        none("No attributes")
      );
    }
    case "optionNames": {
      const names = Object.entries(listing.optionNames);
      return names.length ? (
        <ul className="space-y-0.5 text-sm">
          {names.map(([column, name]) => (
            <li key={column}>
              {humanize(column)} is shown as {humanize(name)}
            </li>
          ))}
        </ul>
      ) : (
        none("As the sheet names them")
      );
    }
    case "claims":
      return listing.claims.length ? (
        <ul className="space-y-1 text-sm">
          {listing.claims.map((claim, i) => (
            <li key={i}>
              <span className="font-medium">{claim.text}</span> <span className="italic text-muted-foreground">“{claim.quote}”</span>
            </li>
          ))}
        </ul>
      ) : (
        none("No quality claims")
      );
  }
}
