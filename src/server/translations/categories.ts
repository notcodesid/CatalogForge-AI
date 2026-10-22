import type { Locale } from "./fields";

// The category list is fixed (ai/taxonomy.ts), so its translations are written once, here: free, and the same
// on every product. Each part of a path ("Home & Garden > Kitchen & Dining > Kitchen Tools") is translated on its own
const PARTS: Record<string, Record<Locale, string>> = {
  "Home & Garden": { de: "Haus & Garten", fr: "Maison & Jardin" },
  Planters: { de: "Pflanzgefäße", fr: "Pots & Jardinières" },
  "Garden Furniture": { de: "Gartenmöbel", fr: "Mobilier de jardin" },
  "Garden Tools": { de: "Gartenwerkzeuge", fr: "Outils de jardin" },
  Watering: { de: "Bewässerung", fr: "Arrosage" },
  "Seeds & Propagation": { de: "Saatgut & Anzucht", fr: "Graines & Semis" },
  "Plant Care": { de: "Pflanzenpflege", fr: "Soin des plantes" },
  "Outdoor Decor": { de: "Gartendeko", fr: "Décoration extérieure" },
  "Outdoor Lighting": { de: "Außenbeleuchtung", fr: "Éclairage extérieur" },
  Doormats: { de: "Fußmatten", fr: "Paillassons" },
  "Bird & Wildlife": { de: "Vögel & Wildtiere", fr: "Oiseaux & Faune" },
  Decor: { de: "Dekoration", fr: "Décoration" },
  Vases: { de: "Vasen", fr: "Vases" },
  "Candles & Home Fragrance": { de: "Kerzen & Raumdüfte", fr: "Bougies & Parfums d'intérieur" },
  "Cushions & Throws": { de: "Kissen & Decken", fr: "Coussins & Plaids" },
  "Wall Decor": { de: "Wanddeko", fr: "Décoration murale" },
  Clocks: { de: "Uhren", fr: "Horloges" },
  "Baskets & Storage": { de: "Körbe & Aufbewahrung", fr: "Paniers & Rangement" },
  Lighting: { de: "Beleuchtung", fr: "Luminaires" },
  Lamps: { de: "Lampen", fr: "Lampes" },
  "Ceiling Lights": { de: "Deckenleuchten", fr: "Plafonniers" },
  Furniture: { de: "Möbel", fr: "Meubles" },
  Tables: { de: "Tische", fr: "Tables" },
  Seating: { de: "Sitzmöbel", fr: "Assises" },
  Shelving: { de: "Regale", fr: "Étagères" },
  "Bedding & Bath": { de: "Schlafen & Bad", fr: "Linge de lit & Bain" },
  Bedding: { de: "Bettwäsche", fr: "Linge de lit" },
  Towels: { de: "Handtücher", fr: "Serviettes" },
  "Bath Accessories": { de: "Badaccessoires", fr: "Accessoires de salle de bain" },
  "Kitchen & Dining": { de: "Küche & Esszimmer", fr: "Cuisine & Arts de la table" },
  "Mugs & Cups": { de: "Tassen & Becher", fr: "Tasses & Mugs" },
  "Plates & Bowls": { de: "Teller & Schalen", fr: "Assiettes & Bols" },
  Cookware: { de: "Kochgeschirr", fr: "Ustensiles de cuisson" },
  "Kitchen Tools": { de: "Küchenhelfer", fr: "Ustensiles de cuisine" },
  "Food Storage": { de: "Vorratsbehälter", fr: "Conservation des aliments" },
  Glassware: { de: "Gläser", fr: "Verrerie" },
  "Table Linen": { de: "Tischwäsche", fr: "Linge de table" },
  "Cleaning & Laundry": { de: "Reinigung & Wäsche", fr: "Entretien & Linge" },
  "Bags & Accessories": { de: "Taschen & Accessoires", fr: "Sacs & Accessoires" },
  Bags: { de: "Taschen", fr: "Sacs" },
  Jewellery: { de: "Schmuck", fr: "Bijoux" },
  Clothing: { de: "Bekleidung", fr: "Vêtements" },
  Women: { de: "Damen", fr: "Femme" },
  Men: { de: "Herren", fr: "Homme" },
  Kids: { de: "Kinder", fr: "Enfant" },
  "Health & Beauty": { de: "Gesundheit & Schönheit", fr: "Santé & Beauté" },
  "Skin Care": { de: "Hautpflege", fr: "Soins de la peau" },
  "Bath & Body": { de: "Bad & Körper", fr: "Bain & Corps" },
  "Sports & Outdoors": { de: "Sport & Outdoor", fr: "Sport & Plein air" },
  "Fitness & Yoga": { de: "Fitness & Yoga", fr: "Fitness & Yoga" },
  Camping: { de: "Camping", fr: "Camping" },
  "Toys & Games": { de: "Spielzeug & Spiele", fr: "Jouets & Jeux" },
  "Pet Supplies": { de: "Tierbedarf", fr: "Animalerie" },
  "Stationery & Office": { de: "Schreibwaren & Büro", fr: "Papeterie & Bureau" },
  Gifts: { de: "Geschenke", fr: "Cadeaux" },
  "Gift Cards": { de: "Geschenkgutscheine", fr: "Cartes cadeaux" },
  Other: { de: "Sonstiges", fr: "Autres" },
};

export function translateCategory(category: string | null, locale: Locale | "en"): string | null {
  if (!category || locale === "en") return category;
  return category
    .split(" > ")
    .map((part) => PARTS[part]?.[locale] ?? part)
    .join(" > ");
}

// Every part of every category in the list has a translation (checked by a test)
export const translatedCategoryParts = () => Object.keys(PARTS);
