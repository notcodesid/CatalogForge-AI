import Link from "next/link";

// A product that doesn't exist, isn't approved yet, or was deleted. The page doesn't know the shopper's language
// here, so it says it in all three
export default function ProductNotFound() {
  return (
    <main className="mx-auto flex w-full max-w-xl flex-1 flex-col items-center justify-center gap-3 px-4 py-24 text-center">
      <h1 className="text-2xl font-semibold">Product not found</h1>
      <p className="text-stone-500">
        <span lang="de">Produkt nicht gefunden</span> · <span lang="fr">Produit introuvable</span>
      </p>
      <Link href="/shop" className="mt-4 rounded-full border border-stone-300 px-4 py-2 text-sm hover:border-stone-900 dark:border-stone-700">
        CatalogForge Shop
      </Link>
    </main>
  );
}
