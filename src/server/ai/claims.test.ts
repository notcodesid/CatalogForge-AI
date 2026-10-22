import { describe, expect, it } from "vitest";
import { claimedConcepts, findMentions } from "./claims";

const said = (text: string) => findMentions(text).map((m) => `${m.negated ? "not " : ""}${m.concept.id}`);

describe("findMentions", () => {
  it("knows a claim from the words that deny it", () => {
    expect(said("frost-resistant (not frost-proof, bring indoors below 0 °C)")).toEqual(["not frost-proof", "frost-resistant"]);
    expect(said("Handgemachter Übertopf aus Keramik. Nicht frostfest.")).toEqual(["not frost-proof", "handmade"]);
  });

  it("stops a denial at the claim it was about", () => {
    expect(said("Not dishwasher safe, hand wash only.")).toEqual(["not dishwasher-safe", "hand-wash"]);
    expect(said("Do not tumble dry. Dry clean only")).toEqual(["dry-clean", "not tumble-dry"]);
    // Within one clause a denial still covers everything after it
    expect(said("Not organic or recycled")).toEqual(["not organic", "not recycled"]);
    expect(said("Not suitable for dishwasher, microwave or oven")).toEqual(["not microwave-safe"]);
  });

  it("knows care instructions in English, German and French", () => {
    expect(claimedConcepts("Machine washable at 40 °C.")).toEqual(new Set(["machine-washable"]));
    expect(claimedConcepts("In der Waschmaschine bei 30 °C waschbar. Nicht in den Trockner.")).toEqual(new Set(["machine-washable"]));
    expect(claimedConcepts("Lavable en machine à 30 °C, nettoyage à sec possible.")).toEqual(new Set(["machine-washable", "dry-clean"]));
    expect(claimedConcepts("Handwäsche empfohlen. Wipe clean with a damp cloth.")).toEqual(new Set(["hand-wash", "wipe-clean"]));
    expect(claimedConcepts("Ovenproof up to 220 °C")).toEqual(new Set(["oven-safe"]));
  });
});
