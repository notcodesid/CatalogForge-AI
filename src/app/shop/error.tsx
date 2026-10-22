"use client";

import Link from "next/link";

// Something broke while loading a shop page. Shoppers get a short message and a way to try again instead of a blank
// error page; the real error is in the server's log (error.digest points to it). Like not-found, in all three languages
export default function ShopError({ retry }: { error: unknown; retry: () => void }) {
  return (
    <main className="mx-auto flex w-full max-w-xl flex-1 flex-col items-center justify-center gap-3 px-4 py-24 text-center">
      <h1 className="text-2xl font-semibold">This page didn&apos;t load</h1>
      <p className="text-stone-500">
        <span lang="de">Die Seite konnte nicht geladen werden</span> · <span lang="fr">La page n&apos;a pas pu être chargée</span>
      </p>
      <div className="mt-4 flex flex-wrap justify-center gap-2">
        <button type="button" onClick={() => retry()} className="rounded-full bg-stone-900 px-4 py-2 text-sm text-white hover:opacity-90 dark:bg-stone-100 dark:text-stone-900">
          Try again
        </button>
        <Link href="/shop" className="rounded-full border border-stone-300 px-4 py-2 text-sm hover:border-stone-900 dark:border-stone-700">
          CatalogForge Shop
        </Link>
      </div>
    </main>
  );
}
