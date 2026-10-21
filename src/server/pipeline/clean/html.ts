import sanitizeHtml from "sanitize-html";
import { cleanText } from "./text";

// Only basic formatting survives. No attributes at all, so no onclick=, style= or javascript: links.
// <script> and <style> are removed together with their content
const ALLOWED = {
  allowedTags: ["p", "br", "ul", "ol", "li", "strong", "em"],
  allowedAttributes: {},
  transformTags: { b: "strong", i: "em" },
};

const UNSAFE = /<\s*(script|style|iframe|object|embed|form|input|link|meta)\b|\son[a-z]+\s*=|javascript:/i;

// More than this and the AI step will only read the start of it
export const LONG_DESCRIPTION_CHARS = 2000;

export type DescriptionResult = {
  html: string;
  // Same text without tags, used for language detection and checking AI claims
  text: string;
  removedUnsafe: boolean;
};

function decodeEntities(text: string) {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

export function cleanDescription(raw: string | null | undefined): DescriptionResult | null {
  const input = cleanText(raw);
  if (!input) return null;

  let html = sanitizeHtml(input, ALLOWED).trim();
  if (!html) return null;
  // Plain text gets wrapped so every description is HTML
  if (!/^<(p|ul|ol)\b/.test(html)) html = `<p>${html}</p>`;

  // Put a space where block tags end so words from separate paragraphs don't stick together
  const spaced = html.replace(/<\/(p|li)>|<br\s*\/?>/g, " ");
  const text = cleanText(decodeEntities(sanitizeHtml(spaced, { allowedTags: [], allowedAttributes: {} }))) ?? "";

  return { html, text, removedUnsafe: UNSAFE.test(input) };
}
