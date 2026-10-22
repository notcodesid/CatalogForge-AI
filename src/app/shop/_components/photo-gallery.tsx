"use client";

import Image from "next/image";
import { useState } from "react";
import type { ShopPhoto } from "@/server/storefront/data";

// The large photo (at most 1600 px) and the thumbnails (400 px) underneath to switch between them
export function PhotoGallery({ photos, title, noPhoto, photoLabels }: { photos: ShopPhoto[]; title: string; noPhoto: string; photoLabels: string[] }) {
  const [shown, setShown] = useState(0);
  if (!photos.length) {
    return <div className="flex aspect-square items-center justify-center rounded-2xl bg-stone-100 text-stone-400 dark:bg-stone-900">{noPhoto}</div>;
  }
  const photo = photos[Math.min(shown, photos.length - 1)];
  return (
    <div>
      <div className="aspect-square overflow-hidden rounded-2xl bg-stone-100 dark:bg-stone-900">
        <Image
          unoptimized
          priority
          src={`/api/photos/${photo.id}`}
          alt={title}
          width={photo.width ?? 1600}
          height={photo.height ?? 1600}
          className="h-full w-full object-contain"
        />
      </div>
      {photos.length > 1 && (
        <ul className="mt-3 flex gap-2 overflow-x-auto pb-1">
          {photos.map((p, i) => (
            <li key={p.id} className="shrink-0">
              <button
                type="button"
                onClick={() => setShown(i)}
                aria-label={photoLabels[i]}
                aria-pressed={i === shown}
                className="block h-16 w-16 overflow-hidden rounded-lg border-2 border-transparent bg-stone-100 aria-pressed:border-stone-900 sm:h-20 sm:w-20 dark:bg-stone-900 dark:aria-pressed:border-stone-100"
              >
                <Image unoptimized src={`/api/photos/${p.id}?size=thumb`} alt="" width={p.width ?? 400} height={p.height ?? 400} className="h-full w-full object-cover" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
