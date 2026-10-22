import { LANGUAGE_NAMES } from "../statuses";
import { Badge, Dot, type Tone } from "../ui";
import type { ProductStatus, TranslationStatus } from "./api";
import { confidenceLabel, confidenceTone, PRODUCT_STATUS_LABEL } from "./view";

// Small pieces the Products table and the review screen both show

export function StatusBadge({ status, deleted }: { status: ProductStatus; deleted?: boolean }) {
  const s = deleted ? { tone: "danger" as const, label: "Deleted" } : PRODUCT_STATUS_LABEL[status];
  // One line, even in a narrow table column
  return (
    <span className="whitespace-nowrap">
      <Badge tone={s.tone}>{s.label}</Badge>
    </span>
  );
}

// An approved product whose listing the AI wrote again: the new version waits for the merchant to use it or not
export function UpdateWaitingBadge() {
  return (
    <span className="whitespace-nowrap" title="The AI wrote a new version of the listing. The shop shows the approved one until you choose">
      <Badge tone="warning">Update waiting</Badge>
    </span>
  );
}

// "● 84%" in the confidence colour. The word next to the colour keeps it readable without seeing colour
export function ConfidenceBadge({ value, label }: { value: number | null | undefined; label?: string }) {
  const tone = confidenceTone(value);
  const word = tone === "success" ? "sure" : tone === "warning" ? "fairly sure" : tone === "danger" ? "unsure" : "";
  return (
    <span
      className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium tabular-nums"
      title={word ? `The AI is ${word}${label ? ` about the ${label}` : ""}` : undefined}
    >
      <Dot tone={tone} />
      <span className={tone === "danger" ? "text-danger" : tone === "warning" ? "text-warning" : tone === "success" ? "text-success" : "text-muted-foreground"}>
        {confidenceLabel(value)}
      </span>
      {word && <span className="sr-only">({word})</span>}
    </span>
  );
}

const TRANSLATION_TONE: Record<TranslationStatus, { tone: Tone; word: string }> = {
  done: { tone: "success", word: "translated" },
  pending: { tone: "info", word: "translating" },
  failed: { tone: "danger", word: "failed" },
};

// "DE ✓ FR …": where each language's translation stands
export function TranslationChips({ translations }: { translations: Record<string, TranslationStatus | null> }) {
  const locales = ["de", "fr"];
  return (
    <span className="inline-flex flex-wrap gap-1">
      {locales.map((locale) => {
        const status = translations[locale];
        const t = status ? TRANSLATION_TONE[status] : null;
        return (
          <span key={locale} title={`${LANGUAGE_NAMES[locale] ?? locale}: ${t?.word ?? "not translated"}`}>
            <Badge tone={t?.tone ?? "neutral"}>
              {locale.toUpperCase()}
              <span className="sr-only">: {t?.word ?? "not translated"}</span>
            </Badge>
          </span>
        );
      })}
    </span>
  );
}

// A product photo's small version. Plain <img>: next/image would need a config change for the "?size=thumb" address
export function Thumb({ url, alt, size = "size-10" }: { url: string | null; alt: string; size?: string }) {
  if (!url) return <span aria-hidden className={`${size} block shrink-0 rounded-md border border-dashed border-border bg-muted`} />;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={url} alt={alt} loading="lazy" className={`${size} shrink-0 rounded-md border border-border bg-muted object-cover`} />;
}
