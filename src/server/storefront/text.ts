import type { Language } from "./country";

// The storefront's own words (buttons, labels, messages). Products are translated by the pipeline; these few
// fixed strings are written here once
const TEXT = {
  en: {
    shopName: "CatalogForge Shop",
    metaDescription: "Products from our catalog, in your language.",
    allProducts: "All products",
    from: "from",
    priceOnRequest: "Price on request",
    description: "Description",
    details: "Details",
    sku: "SKU",
    noProducts: "No products here yet.",
    backToShop: "Back to the shop",
    noPhoto: "No photo yet",
    previous: "Previous",
    next: "Next",
    pageOf: (page: number, pages: number) => `Page ${page} of ${pages}`,
    productCount: (n: number) => (n === 1 ? "1 product" : `${n} products`),
    country: "Country",
    otherCountries: "Other countries",
    notAvailable: "This combination isn't available",
    photo: (n: number) => `Photo ${n}`,
  },
  de: {
    shopName: "CatalogForge Shop",
    metaDescription: "Produkte aus unserem Katalog, in Ihrer Sprache.",
    allProducts: "Alle Produkte",
    from: "ab",
    priceOnRequest: "Preis auf Anfrage",
    description: "Beschreibung",
    details: "Details",
    sku: "Artikelnummer",
    noProducts: "Hier gibt es noch keine Produkte.",
    backToShop: "Zurück zum Shop",
    noPhoto: "Noch kein Foto",
    previous: "Zurück",
    next: "Weiter",
    pageOf: (page: number, pages: number) => `Seite ${page} von ${pages}`,
    productCount: (n: number) => (n === 1 ? "1 Produkt" : `${n} Produkte`),
    country: "Land",
    otherCountries: "Andere Länder",
    notAvailable: "Diese Kombination ist nicht erhältlich",
    photo: (n: number) => `Foto ${n}`,
  },
  fr: {
    shopName: "Boutique CatalogForge",
    metaDescription: "Les produits de notre catalogue, dans votre langue.",
    allProducts: "Tous les produits",
    from: "à partir de",
    priceOnRequest: "Prix sur demande",
    description: "Description",
    details: "Caractéristiques",
    sku: "Référence",
    noProducts: "Aucun produit pour le moment.",
    backToShop: "Retour à la boutique",
    noPhoto: "Pas encore de photo",
    previous: "Précédent",
    next: "Suivant",
    pageOf: (page: number, pages: number) => `Page ${page} sur ${pages}`,
    productCount: (n: number) => (n <= 1 ? `${n} produit` : `${n} produits`),
    country: "Pays",
    otherCountries: "Autres pays",
    notAvailable: "Cette combinaison n'est pas disponible",
    photo: (n: number) => `Photo ${n}`,
  },
} satisfies Record<Language, unknown>;

export type ShopText = (typeof TEXT)["en"];

export function shopText(language: Language): ShopText {
  return TEXT[language];
}
