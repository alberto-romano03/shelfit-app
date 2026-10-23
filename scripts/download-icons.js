// One-time helper: download only the specific Lucide SVG icons this app uses,
// as raw static assets (no npm dependency). Run manually — it is NOT part of the
// build pipeline:
//
//   node scripts/download-icons.js
//
// Files are written to client/public/icons/lucide/<name>.svg and served by Vite
// as static assets under <base>/icons/lucide/<name>.svg.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, '..', 'client', 'public', 'icons', 'lucide');
const RAW_BASE = 'https://raw.githubusercontent.com/lucide-icons/lucide/main/icons';

// Only the icons the detail popup needs.
const ICONS = [
  // Metadata rows (below the title).
  'calendar',
  'clock',
  'tag',
  // Bento "Details" section.
  'circle-check', // Released / Concluded status
  'circle-play', // In Production / Airing status
  'circle-pause', // On Hiatus status
  'circle-x', // Cancelled status
  'tv', // Network / Platform
  'clapperboard', // Production company
  'users', // Creators
  'wallet', // Budget
  'trending-up', // Box office revenue
  'layers', // Seasons and episodes
  'calendar-check', // Last aired date
  'shield', // Age rating
  'layout-template', // "Details" (Liner Notes) section title
  // Status selector bento.
  'calendar-plus', // Plan to Watch
  'eye', // Watching
  'library-big', // Shelved (formerly Completed)
  'pause', // Paused
  'x', // Dropped
  // Options menu bento.
  'list-plus', // Add to list
  'refresh-cw', // Refresh metadata
  'eraser', // Clear cache
  'images', // Customize metadata (the custom-artwork flow)
  'image-up', // …and its "from your device" source
  'zoom-out', // crop tool zoom slider ends
  'zoom-in',
  'trash-2', // Remove from library
  // Cinema tickets (watched-in-cinema flag + ticket collection).
  'ticket', // Watched in Cinema button + ticket modal empty state
  'popcorn', // ticket cinema-name field
  'wallet-cards', // My Tickets "Collection" view switch
  // Kodi Now Playing toast.
  'volume-2', // audio track chip
  'captions', // subtitle track chip
  // Server offline/online toast icons.
  'globe-off', // offline
  'eject', // recovered
  'disc',
  // Kodi "Now Playing" chip + panel (audio / subtitle rows).
  'audio-lines', // Now Playing chip — pulsing "sound" glyph
  'play', // Now Playing indicator — pulsing play glyph
  'volume-2',
  'captions',
  // Detail bento + receipt.
  'user-round', // Movie director
  'palette', // Receipt: solid colour
  'blend', // Receipt: gradient
  'image', // Receipt: poster
  'droplets', // Receipt: blur (medium)
  'droplet', // Receipt: blur toggle + light
  'droplet-off', // Receipt: blur off
  'cloud-fog', // Receipt: blur heavy
  // Season episode-list action buttons.
  'check-check', // "Mark all watched"
  'signpost', // "Jump to latest"
  // Kodi settings action buttons.
  'book-check', // "Sync library now"
  'server-plus', // "Add instance"
  'locate-fixed', // instance "Test"
  'square-pen', // instance "Edit"
  // (trash-2 for instance "Delete" is already listed above)
  // Settings → Appearance language picker.
  'languages',
  // Settings → Appearance theme picker (segmented control).
  'sun-moon', // System (follow the OS)
  'moon', // Dark
  'sun', // Light
];

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  for (const name of ICONS) {
    const url = `${RAW_BASE}/${name}.svg`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to download ${name}: HTTP ${res.status}`);
    const svg = await res.text();
    const dest = path.join(OUT_DIR, `${name}.svg`);
    await writeFile(dest, svg, 'utf8');
    console.log(`✓ ${name}.svg (${svg.length} bytes)`);
  }
  console.log(`Saved ${ICONS.length} icons to ${OUT_DIR}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
