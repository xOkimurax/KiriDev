// Verifica que el motor de filtros del servidor y el de la web sean idénticos (el build de la web no ve la carpeta del servidor).
import fs from 'node:fs';
const a = fs.readFileSync(new URL('../server/src/filters.js', import.meta.url), 'utf8'), b = fs.readFileSync(new URL('../web/src/components/filters.js', import.meta.url), 'utf8');
if (a !== b) { console.error('server/src/filters.js y web/src/components/filters.js difieren: copiá uno al otro.'); process.exit(1); }
console.log('filters.js sincronizado');
