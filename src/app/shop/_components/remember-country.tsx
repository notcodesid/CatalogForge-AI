"use client";

import { useEffect } from "react";
import { COUNTRY_COOKIE } from "@/server/storefront/country";

// The country switcher is plain links (?country=DE), so it works without JavaScript and search engines can follow
// it. A page can't set a cookie while it renders, so this saves the choice from the browser: later visits without
// ?country= keep the shopper's country
export function RememberCountry({ country }: { country: string | null }) {
  useEffect(() => {
    if (country) document.cookie = `${COUNTRY_COOKIE}=${country}; path=/shop; max-age=31536000; samesite=lax`;
  }, [country]);
  return null;
}
