"use client";

import {
  createColumnHelper,
  functionalUpdate,
  rowSelectionFeature,
  rowSortingFeature,
  tableFeatures,
  useTable,
  type RowSelectionState,
} from "@tanstack/react-table";
import Link from "next/link";
import { useEffect, useRef } from "react";
import { formatCount, timeAgo } from "../format";
import { focusClasses, linkClasses } from "../ui";
import type { ProductRow } from "./api";
import { ConfidenceBadge, StatusBadge, Thumb, TranslationChips } from "./bits";
import { categoryLeaf, type ListView, priceRange, type Sort, SORTS, toggleSort } from "./view";

// Sorting and pages are done by the server (the catalog can hold 10,000+ products), so the table only renders the
// page it's given, keeps the selection, and reports clicks on sortable headers
const features = tableFeatures({
  rowSelectionFeature,
  rowSortingFeature,
  // Per column: extra classes (some columns are hidden on small screens)
  columnMeta: {} as { className?: string },
});

const column = createColumnHelper<typeof features, ProductRow>();

const columns = column.columns([
  column.display({
    id: "select",
    header: ({ table }) => (
      <Checkbox
        label="Select every product on this page"
        checked={table.getIsAllPageRowsSelected()}
        indeterminate={table.getIsSomePageRowsSelected()}
        onChange={table.getToggleAllPageRowsSelectedHandler()}
      />
    ),
    cell: ({ row }) => (
      <Checkbox label={`Select ${row.original.title}`} checked={row.getIsSelected()} disabled={!row.getCanSelect()} onChange={row.getToggleSelectedHandler()} />
    ),
    meta: { className: "w-10" },
  }),
  column.accessor("title", {
    header: "Product",
    cell: ({ row }) => <TitleCell product={row.original} />,
  }),
  // On a phone, status, confidence and price are folded into the product cell (see TitleCell)
  column.accessor("status", {
    header: "Status",
    cell: ({ row }) => <StatusBadge status={row.original.status} deleted={Boolean(row.original.deletedAt)} />,
    meta: { className: "hidden sm:table-cell" },
  }),
  column.accessor("lowestConfidence", {
    id: "confidence",
    header: "Confidence",
    cell: ({ getValue }) => <ConfidenceBadge value={getValue()} />,
    meta: { className: "hidden sm:table-cell" },
  }),
  column.accessor("category", {
    header: "Category",
    cell: ({ getValue }) => {
      const category = getValue();
      return category ? (
        <span title={category} className="block max-w-40 truncate">
          {categoryLeaf(category)}
        </span>
      ) : (
        <span className="text-muted-foreground">None</span>
      );
    },
    meta: { className: "hidden lg:table-cell" },
  }),
  column.accessor("minPriceCents", {
    id: "price",
    header: "Price",
    cell: ({ row }) => <PriceCell product={row.original} />,
    meta: { className: "hidden sm:table-cell" },
  }),
  column.accessor("variantCount", {
    header: "Variants",
    enableSorting: false,
    cell: ({ getValue }) => <span className="tabular-nums">{formatCount(getValue())}</span>,
    meta: { className: "hidden xl:table-cell" },
  }),
  column.accessor("translations", {
    header: "Translations",
    enableSorting: false,
    cell: ({ getValue }) => <TranslationChips translations={getValue()} />,
    meta: { className: "hidden md:table-cell" },
  }),
  column.accessor("updatedAt", {
    header: "Updated",
    cell: ({ getValue }) => (
      <time dateTime={getValue()} title={new Date(getValue()).toLocaleString("en")} className="whitespace-nowrap text-muted-foreground">
        {timeAgo(getValue())}
      </time>
    ),
    meta: { className: "hidden sm:table-cell" },
  }),
]);

export function ProductTable({
  products,
  view,
  selection,
  onSelectionChange,
  onViewChange,
}: {
  products: ProductRow[];
  view: ListView;
  selection: RowSelectionState;
  onSelectionChange: (next: RowSelectionState) => void;
  onViewChange: (next: ListView) => void;
}) {
  const table = useTable({
    features,
    columns,
    data: products,
    // Selection is kept by product id, so it survives turning pages
    getRowId: (row) => row.id,
    manualSorting: true,
    enableMultiSort: false,
    // A deleted product can't be approved, so there's nothing to select it for
    enableRowSelection: (row) => !row.original.deletedAt,
    state: { sorting: [{ id: view.sort, desc: view.order === "desc" }], rowSelection: selection },
    onRowSelectionChange: (updater) => onSelectionChange(functionalUpdate(updater, selection)),
  });

  return (
    // `relative`: the screen-reader words in columns scrolled out of view are positioned inside this box, else
    // they'd widen the whole page on a phone
    <div className="relative overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-left text-sm sm:min-w-[560px]">
        <thead className="bg-muted text-muted-foreground">
          {table.getHeaderGroups().map((group) => (
            <tr key={group.id}>
              {group.headers.map((header) => {
                const id = header.column.id;
                const sortable = (SORTS as readonly string[]).includes(id);
                const sorted = header.column.getIsSorted();
                return (
                  <th
                    key={header.id}
                    scope="col"
                    aria-sort={sortable ? (sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : "none") : undefined}
                    className={`px-3 py-2 font-medium ${header.column.columnDef.meta?.className ?? ""}`}
                  >
                    {sortable ? (
                      <button
                        type="button"
                        onClick={() => onViewChange(toggleSort(view, id as Sort))}
                        className={`-mx-1 inline-flex min-h-8 items-center gap-1 rounded px-1 hover:text-foreground ${focusClasses} ${sorted ? "text-foreground" : ""}`}
                      >
                        <table.FlexRender header={header} />
                        <span aria-hidden className="text-xs">
                          {sorted === "asc" ? "▲" : sorted === "desc" ? "▼" : "↕"}
                        </span>
                      </button>
                    ) : (
                      <table.FlexRender header={header} />
                    )}
                  </th>
                );
              })}
            </tr>
          ))}
        </thead>
        <tbody className="divide-y divide-border bg-card">
          {table.getRowModel().rows.map((row) => (
            <tr key={row.id} className={row.getIsSelected() ? "bg-info-soft" : undefined}>
              {row.getAllCells().map((cell) => (
                <td key={cell.id} className={`px-3 py-2 align-top ${cell.column.columnDef.meta?.className ?? ""}`}>
                  <table.FlexRender cell={cell} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TitleCell({ product }: { product: ProductRow }) {
  // The first reason it needs review is the most useful line to see in the list
  const firstReason = product.reviewReason?.split("; ")[0];
  return (
    <div className="flex items-start gap-3 sm:min-w-48">
      <Thumb url={product.thumbnailUrl} alt="" />
      <div className="min-w-0 space-y-0.5">
        <Link href={`/products/${product.id}`} className={`${linkClasses} block break-words text-foreground`}>
          {product.title}
        </Link>
        <p className="truncate font-mono text-xs text-muted-foreground">{product.handle}</p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 py-0.5 sm:hidden">
          <StatusBadge status={product.status} deleted={Boolean(product.deletedAt)} />
          <ConfidenceBadge value={product.lowestConfidence} />
          <span className="text-xs tabular-nums">{priceRange(product) ?? "No price"}</span>
        </div>
        {product.editedFields.length > 0 && <p className="text-xs text-muted-foreground">Edited by you</p>}
        {firstReason && product.status === "needs_review" && (
          <p className="line-clamp-2 max-w-sm text-xs text-warning" title={product.reviewReason ?? undefined}>
            {firstReason}
          </p>
        )}
      </div>
    </div>
  );
}

function PriceCell({ product }: { product: ProductRow }) {
  const price = priceRange(product);
  return (
    <div className="space-y-0.5 whitespace-nowrap tabular-nums">
      {price ? <span>{price}</span> : <span className="text-muted-foreground">No price</span>}
      {product.variantsWithoutPrice > 0 && price && <p className="text-xs text-danger">{formatCount(product.variantsWithoutPrice)} without a price</p>}
    </div>
  );
}

// A checkbox that can also show "some selected" (a native checkbox can, but only from script)
function Checkbox({
  label,
  checked,
  indeterminate = false,
  disabled = false,
  onChange,
}: {
  label: string;
  checked: boolean;
  indeterminate?: boolean;
  disabled?: boolean;
  onChange: (event: unknown) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate && !checked;
  }, [indeterminate, checked]);
  return (
    <input
      ref={ref}
      type="checkbox"
      aria-label={label}
      checked={checked}
      disabled={disabled}
      onChange={onChange}
      className={`size-4 cursor-pointer rounded border-border accent-foreground disabled:cursor-not-allowed ${focusClasses}`}
    />
  );
}
