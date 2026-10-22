"use client";

import { useMemo, useState } from "react";
import { CATEGORIES } from "@/server/ai/taxonomy";
import { buttonClasses, focusClasses } from "../ui";
import { type EditResult, errorMessage, type ProductDetail, sendJson } from "./api";
import { categoryGroups, tagsFromText, tagsToText } from "./view";

const inputClasses = `w-full rounded-md border border-border bg-background px-3 py-2 text-sm ${focusClasses}`;

// The merchant's own edit of the English. Only the fields that really changed are sent: those become theirs
// (a re-upload won't overwrite them) and only those are translated again
export function EditForm({ product, onSaved, onCancel }: { product: ProductDetail; onSaved: (result: EditResult) => void; onCancel: () => void }) {
  const [title, setTitle] = useState(product.title);
  const [description, setDescription] = useState(product.descriptionHtml);
  const [category, setCategory] = useState(product.category ?? "");
  const [tags, setTags] = useState(tagsToText(product.tags));
  const [attributes, setAttributes] = useState(() => Object.entries(product.attributes).map(([key, value]) => ({ key, value })));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const groups = useMemo(() => categoryGroups(CATEGORIES), []);

  const changes = () => {
    const body: Record<string, unknown> = {};
    if (title.trim() !== product.title) body.title = title;
    if (description !== product.descriptionHtml) body.descriptionHtml = description;
    if ((category || null) !== product.category) body.category = category || null;
    const nextTags = tagsFromText(tags);
    if (nextTags.join("\n") !== product.tags.join("\n")) body.tags = nextTags;
    const nextAttributes = Object.fromEntries(attributes.filter((a) => a.key.trim() && a.value.trim()).map((a) => [a.key.trim().toLowerCase(), a.value.trim()]));
    if (JSON.stringify(Object.entries(nextAttributes).sort()) !== JSON.stringify(Object.entries(product.attributes).sort())) body.attributes = nextAttributes;
    return body;
  };

  const save = async () => {
    const body = changes();
    if (!Object.keys(body).length) {
      onSaved({ changed: [], warnings: [], product });
      return;
    }
    setSaving(true);
    setError(null);
    try {
      onSaved(await sendJson<EditResult>("PATCH", `/api/products/${product.id}`, body));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      aria-labelledby="edit-heading"
      className="space-y-4 rounded-lg border border-info/40 bg-card p-4 md:p-5"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="space-y-1">
        <h2 id="edit-heading" className="text-base font-semibold">
          Edit the listing
        </h2>
        <p className="text-xs text-muted-foreground">
          What you change here is yours: a re-upload of the sheet won&apos;t overwrite it, and only the changed fields are translated again.
        </p>
      </div>

      <label className="block space-y-1 text-sm">
        <span className="font-medium">Title</span>
        <input required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} className={inputClasses} />
      </label>

      <label className="block space-y-1 text-sm">
        <span className="font-medium">Description</span>
        <span className="block text-xs text-muted-foreground">HTML. Only paragraphs, lists, bold and italics are kept.</span>
        <textarea rows={8} value={description} onChange={(e) => setDescription(e.target.value)} className={`${inputClasses} font-mono text-xs`} />
      </label>

      <label className="block space-y-1 text-sm">
        <span className="font-medium">Category</span>
        <select value={category} onChange={(e) => setCategory(e.target.value)} className={inputClasses}>
          <option value="">No category</option>
          {groups.map((g) => (
            <optgroup key={g.top} label={g.top}>
              {(g.children.length ? g.children : [g.top]).map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>

      <label className="block space-y-1 text-sm">
        <span className="font-medium">Tags</span>
        <span className="block text-xs text-muted-foreground">Separated by commas</span>
        <input value={tags} onChange={(e) => setTags(e.target.value)} className={inputClasses} />
      </label>

      <fieldset className="space-y-2 text-sm">
        <legend className="font-medium">Attributes</legend>
        <p className="text-xs text-muted-foreground">Colour, size, price, SKU and weight belong to each variant, so they can&apos;t be attributes.</p>
        {attributes.map((attribute, i) => (
          <div key={i} className="flex gap-2">
            <input
              aria-label={`Attribute ${i + 1} name`}
              placeholder="material"
              value={attribute.key}
              onChange={(e) => setAttributes((list) => list.map((a, j) => (j === i ? { ...a, key: e.target.value } : a)))}
              className={`${inputClasses} w-2/5`}
            />
            <input
              aria-label={`Attribute ${i + 1} value`}
              placeholder="terracotta"
              value={attribute.value}
              onChange={(e) => setAttributes((list) => list.map((a, j) => (j === i ? { ...a, value: e.target.value } : a)))}
              className={inputClasses}
            />
            <button
              type="button"
              aria-label={`Remove attribute ${attribute.key || i + 1}`}
              className={buttonClasses("ghost", "sm")}
              onClick={() => setAttributes((list) => list.filter((_, j) => j !== i))}
            >
              ✕
            </button>
          </div>
        ))}
        <button type="button" className={buttonClasses("secondary", "sm")} onClick={() => setAttributes((list) => [...list, { key: "", value: "" }])}>
          Add an attribute
        </button>
      </fieldset>

      {error && (
        <p role="alert" className="rounded-md border border-danger/30 bg-danger-soft p-2 text-sm text-danger">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <button type="submit" className={buttonClasses("primary")} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
        <button type="button" className={buttonClasses("ghost")} onClick={onCancel} disabled={saving}>
          Cancel
        </button>
      </div>
    </form>
  );
}
