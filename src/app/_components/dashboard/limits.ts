// The server's upload limits (imports/create-import.ts, photos/upload.ts), checked in the browser first so the
// merchant hears about a problem before waiting for an upload. limits.test.ts keeps both sides in step
export const LIMITS = {
  sheetBytes: 25 * 1024 * 1024,
  photoBytes: 20 * 1024 * 1024,
  photosPerImport: 2000,
  // One request to the server. Photos go in several requests; one ZIP has to fit in one
  requestBytes: 300 * 1024 * 1024,
};

// Photos are sent in batches, so a big folder is many small requests (each can be retried on its own)
export const PHOTO_BATCH = { files: 20, bytes: 60 * 1024 * 1024 };

export const SHEET_EXTENSIONS = /\.(csv|xlsx|xls)$/i;
export const PHOTO_EXTENSIONS = /\.(jpe?g|png|webp)$/i;
export const ZIP_EXTENSION = /\.zip$/i;
// iPhone photos: the server refuses them, so the browser says so straight away
export const HEIC_EXTENSIONS = /\.(heic|heif)$/i;

// Currencies offered for prices that don't say theirs. The server accepts any ISO code
export const CURRENCIES = ["EUR", "GBP", "USD", "CHF", "SEK", "DKK", "NOK", "PLN", "CZK"];
