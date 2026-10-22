// The only categories a product can get. The AI must pick one of these exactly; anything else sends the
// product to review. Shopify-style paths, so they map cleanly onto a real shop later
export const CATEGORIES = [
  "Home & Garden > Planters",
  "Home & Garden > Garden Furniture",
  "Home & Garden > Garden Tools",
  "Home & Garden > Watering",
  "Home & Garden > Seeds & Propagation",
  "Home & Garden > Plant Care",
  "Home & Garden > Outdoor Decor",
  "Home & Garden > Outdoor Lighting",
  "Home & Garden > Doormats",
  "Home & Garden > Bird & Wildlife",
  "Home & Garden > Decor > Vases",
  "Home & Garden > Decor > Candles & Home Fragrance",
  "Home & Garden > Decor > Cushions & Throws",
  "Home & Garden > Decor > Wall Decor",
  "Home & Garden > Decor > Clocks",
  "Home & Garden > Decor > Baskets & Storage",
  "Home & Garden > Lighting > Lamps",
  "Home & Garden > Lighting > Ceiling Lights",
  "Home & Garden > Furniture > Tables",
  "Home & Garden > Furniture > Seating",
  "Home & Garden > Furniture > Shelving",
  "Home & Garden > Bedding & Bath > Bedding",
  "Home & Garden > Bedding & Bath > Towels",
  "Home & Garden > Bedding & Bath > Bath Accessories",
  "Home & Garden > Kitchen & Dining > Mugs & Cups",
  "Home & Garden > Kitchen & Dining > Plates & Bowls",
  "Home & Garden > Kitchen & Dining > Cookware",
  "Home & Garden > Kitchen & Dining > Kitchen Tools",
  "Home & Garden > Kitchen & Dining > Food Storage",
  "Home & Garden > Kitchen & Dining > Glassware",
  "Home & Garden > Kitchen & Dining > Table Linen",
  "Home & Garden > Cleaning & Laundry",
  "Bags & Accessories > Bags",
  "Bags & Accessories > Jewellery",
  "Clothing > Women",
  "Clothing > Men",
  "Clothing > Kids",
  "Health & Beauty > Skin Care",
  "Health & Beauty > Bath & Body",
  "Sports & Outdoors > Fitness & Yoga",
  "Sports & Outdoors > Camping",
  "Toys & Games",
  "Pet Supplies",
  "Stationery & Office",
  "Gifts > Gift Cards",
  "Other",
] as const;

export type Category = (typeof CATEGORIES)[number];

const SET = new Set<string>(CATEGORIES);

export function isCategory(value: string): value is Category {
  return SET.has(value);
}

const parts = (path: string) => path.split(">").map((p) => p.trim().toLowerCase());

// Whether every part of `wanted` appears in `have`, in the same order
function inOrder(wanted: string[], have: string[]) {
  let i = 0;
  for (const part of have) if (part === wanted[i]) i++;
  return i === wanted.length;
}

// The AI sometimes skips a level ("Home & Garden > Kitchen Tools" for "Home & Garden > Kitchen & Dining >
// Kitchen Tools") or leaves out the top one ("Kitchen & Dining > Mugs & Cups"). When exactly one category in the
// list ends with the same part and has all the others in the same order, that's the one it meant. Anything
// vaguer returns null
export function nearestCategory(value: string): Category | null {
  const wanted = parts(value);
  const matches = CATEGORIES.filter((c) => {
    const have = parts(c);
    return have.at(-1) === wanted.at(-1) && inOrder(wanted, have);
  });
  return matches.length === 1 ? matches[0] : null;
}
