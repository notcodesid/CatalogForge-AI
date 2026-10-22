"use client";

import { useState } from "react";

export type PickerOption = { name: string; label: string; values: { value: string; label: string }[] };
// Prices come formatted from the server, so the browser shows exactly the same text the server rendered
export type PickerVariant = { sku: string; options: Record<string, string>; price: string };

// Size, colour...: one row of buttons per option. The price and SKU follow the variant the choices point to
export function VariantPicker({
  options,
  variants,
  labels,
}: {
  options: PickerOption[];
  variants: PickerVariant[];
  labels: { sku: string; notAvailable: string };
}) {
  const [chosen, setChosen] = useState<Record<string, string>>(() => ({ ...variants[0]?.options }));
  const match = variants.find((v) => options.every((o) => (v.options[o.name] ?? "") === (chosen[o.name] ?? "")));

  return (
    <div className="space-y-5">
      <p className="text-2xl font-semibold" aria-live="polite">
        {match ? match.price : labels.notAvailable}
      </p>
      {options.map((option) => (
        <fieldset key={option.name}>
          <legend className="mb-2 text-sm font-medium text-stone-600 dark:text-stone-400">{option.label}</legend>
          <div className="flex flex-wrap gap-2">
            {option.values.map((value) => (
              <button
                key={value.value}
                type="button"
                aria-pressed={chosen[option.name] === value.value}
                onClick={() => setChosen((c) => ({ ...c, [option.name]: value.value }))}
                className="min-h-10 rounded-full border border-stone-300 px-4 text-sm transition hover:border-stone-900 aria-pressed:border-stone-900 aria-pressed:bg-stone-900 aria-pressed:text-white dark:border-stone-700 dark:hover:border-stone-100 dark:aria-pressed:border-stone-100 dark:aria-pressed:bg-stone-100 dark:aria-pressed:text-stone-900"
              >
                {value.label}
              </button>
            ))}
          </div>
        </fieldset>
      ))}
      {match && (
        <p className="text-xs text-stone-500">
          {labels.sku}: {match.sku}
        </p>
      )}
    </div>
  );
}
