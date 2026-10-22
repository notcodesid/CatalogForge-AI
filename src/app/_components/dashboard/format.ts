// Numbers, sizes and times written the way people read them

export const formatCount = (n: number) => n.toLocaleString("en");

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1).replace(/\.0$/, "")} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1).replace(/\.0$/, "")} GB`;
}

// "just now", "4 min ago", "3 h ago", "2 days ago"
export function timeAgo(iso: string, now = Date.now()) {
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

// "45 s", "3 min 12 s", "1 h 4 min"
export function formatDuration(ms: number) {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total} s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes} min${total % 60 ? ` ${total % 60} s` : ""}`;
  return `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ""}`;
}

// "Paused — resuming in 3 minutes"
export function resumingIn(iso: string | null, now = Date.now()) {
  if (!iso) return "resuming soon";
  const minutes = Math.ceil((new Date(iso).getTime() - now) / 60_000);
  if (minutes <= 0) return "resuming now";
  if (minutes === 1) return "resuming in about a minute";
  return `resuming in ${minutes} minutes`;
}

export const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

// The API's messages have no full stop at the end. Shown next to other text, they need one
export const asSentence = (text: string) => (/[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);

export function formatPrice(cents: number | null, currency: string | null) {
  if (cents === null || !currency) return null;
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}
