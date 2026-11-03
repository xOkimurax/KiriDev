import { useEffect, useState } from 'react';

/** ¿Pantalla angosta (celular)? Las tablas pasan a tarjetas. */
export function useNarrow(px = 760) {
  const q = `(max-width: ${px}px)`;
  const [n, setN] = useState(() => (typeof matchMedia === 'function' ? matchMedia(q).matches : false));
  useEffect(() => { const mq = matchMedia(q), f = () => setN(mq.matches); mq.addEventListener('change', f); return () => mq.removeEventListener('change', f); }, [q]);
  return n;
}
