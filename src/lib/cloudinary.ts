/** Kept as the historical import path for the dashboard's fixed-size thumbnails.
 *  The implementation is `cdnThumb` in ./cdn.ts — the one place image URLs get
 *  optimized, so a non-Cloudinary source (demo data, an imported catalogue) is
 *  resized and cached too instead of being served at full size. */
export { cdnThumb as thumbUrl } from './cdn.js';
