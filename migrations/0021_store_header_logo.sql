-- A seller's own logo at the top of their store, as an OPTION beside the name-and-avatar lockup.
--
-- The owner's framing (2026-08-09): "לתת למוכר את האפשרות להוסיף לוגו לראש האתר ולהראות לו תצוגה
-- מקדימה בדף ההגדרות… ואם זה מוצא חן בעיניו או שהוא רוצה לבחור בהדר פונטי רגיל ותמונה". So this is
-- two columns, not one, and the second is the point: the choice is the seller's and it must survive
-- switching back and forth. Uploading a logo does not adopt it, and going back to the name does not
-- throw it away.
--
-- **Header-only, and that is a decision.** The avatar circle stays exactly as it is everywhere else
-- — store cards on the homepage, search results, the saved-stores menu, order emails. Every one of
-- those is a fixed square or circular slot, and a wide wordmark inside a circle is either cropped to
-- nothing or shrunk to an illegible stripe. A logo is a shape whose whole meaning is its aspect
-- ratio; a slot that dictates the ratio cannot hold one. `profile_image` remains the one image those
-- surfaces read.
--
-- No `_source` twin (compare `banner_image_source` / `profile_image_source`, migration 0012). Those
-- exist because their images are CROPPED and the crop is lossy — re-framing needs the original. A
-- header logo is never cropped: it is drawn `object-fit: contain` inside a box of fixed height, so
-- the upload IS the delivered image and there is nothing to re-frame from.
ALTER TABLE stores ADD COLUMN IF NOT EXISTS header_logo text;

-- 'name' (avatar + store name, today's lockup) or 'logo'. Defaults to 'name', which is what every
-- existing row already renders, so this migration changes no storefront until a seller chooses.
-- CHECK rather than an enum: adding a third style later is an ALTER on the constraint, not a type.
ALTER TABLE stores ADD COLUMN IF NOT EXISTS header_style text NOT NULL DEFAULT 'name';
ALTER TABLE stores DROP CONSTRAINT IF EXISTS stores_header_style_check;
ALTER TABLE stores ADD CONSTRAINT stores_header_style_check CHECK (header_style IN ('name', 'logo'));
