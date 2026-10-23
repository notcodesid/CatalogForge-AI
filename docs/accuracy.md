# Accuracy: how invented claims are stopped

[Back to the README](../README.md)

- **Code, not the AI, does the facts.** Prices become integer cents with a currency, weights become grams, sizes
  keep their metric unit (inches become cm), colours are matched against a list, rows are grouped into products and
  variants. The AI never sets a price, SKU, size or weight. When the same SKU comes with two prices, it gets no
  price until the merchant enters one.
- **Every claim must quote the supplier.** The AI gives the row, column and exact words for each claim. Code checks
  the words are really in the supplier's text (that cell, or else another cell of the product) and that they don't
  deny the claim ("not frost-proof", "nicht frostfest"), using a list of risky claims in English, German and
  French. Care and safety instructions count as claims ("machine washable", "dry clean only"). A "not" only counts
  inside its own sentence. A partial claim ("organic cotton blend") doesn't back a full one ("organic cotton"). A
  claim that fails is removed and the product goes to review.
- **Invented details are caught too.** A description sentence with two or more words the supplier never used goes
  to review, with the sentence shown ("for marking plants in beds, pots and seed trays"). English sheets only: a
  translation shares no words with the German or French it came from.
- **Unsure extras are left out.** A tag the supplier doesn't back is dropped, and so is an attribute the AI scores
  under 70%. They're extras the AI offers, not something to send to review.
- **Unclear means review, not a guess:** a title, description, category or tags scored under 70%, conflicting rows,
  a missing price, a category outside the fixed list, text that looks like instructions to the AI (removed before
  the AI sees it), a note that doesn't fit the product.
- **Translations are checked the same way:** a translation can't make a claim stronger or drop a "not", every
  number, unit, code and HTML tag must survive, and the title and description must really be translated.
- **Tested on real messy files** with the real AI, fixing what they showed (see the commit history).

Why products were in review after the 10,000-row run (1,689 of 6,302 products, 27%; a product can have more than
one reason):

| Reason | Products |
|---|---|
| Price problems planted in the sheet: no price (322), "on request" (224), mixed currencies (136) | about 680 |
| A note that doesn't fit the product. The test generator attaches random notes like "frost-resistant" to cushion covers, and Claude flags them, correctly | about 908 |
| Noise, mostly "material taken from the product name" | about 140 (about 2% of products) |

Earlier the same sheet had 64% of its rows in review. The fixes: leaving out attributes the AI is unsure of,
reading bare weights in the column's unit, joining rows to their family, and stricter rules for when the AI may
flag something.
