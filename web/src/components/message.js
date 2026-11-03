export function parseMessage(message) {
  const raw = String(message?.content || '');
  if (message?.role === 'system') {
    const m = raw.match(/^(🔄|🧩|✅|❌|⛔)\s*(.*)$/u);
    const kinds = {
      '🔄': 'persona',
      '🧩': 'task',
      '✅': 'done',
      '❌': 'failed',
      '⛔': 'cancelled',
    };
    const kind = kinds[m?.[1]] || 'info';
    return { type: 'system', kind, text: m ? m[2] : raw };
  }
  if (message?.role === 'user') {
    const media = [
      ['🎤 ', 'audio'],
      ['🖼️ ', 'image'],
      ['📎 ', 'file'],
      ['🎬 ', 'video'],
      ['📍 ', 'location'],
      ['👤 ', 'contact'],
    ].find(([prefix]) => raw.startsWith(prefix));
    if (media) {
      const [prefix, type] = media;
      const body = raw.slice(prefix.length),
        [head, ...rest] = body.split('\n');
      return { type, text: rest.join('\n').replace(/^🎤 /, 'Transcripción: '), title: head, media: type };
    }
  }
  const lines = raw.split('\n');
  const files = [];
  while (lines.length && /^📎\s+/.test(lines.at(-1))) {
    files.unshift(lines.pop().replace(/^📎\s+/, ''));
  }
  return { type: 'text', text: lines.join('\n'), files };
}

// El encabezado de la tarjeta ya nombra el tipo; evitamos repetir etiquetas genéricas del texto guardado.
export function mediaTitleIsLabel(media, title) {
  const labels = {
    audio: ['audio', 'nota de voz'],
    image: ['imagen'],
    file: ['archivo', 'documento'],
    video: ['video', 'vídeo'],
    location: ['ubicación', 'ubicacion'],
    contact: ['contacto'],
  };
  return (
    labels[media]?.includes(
      String(title || '')
        .trim()
        .replace(/:$/, '')
        .toLocaleLowerCase(),
    ) || false
  );
}

export function plainPreview(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}(?:[-*+]|\d+[.)])\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/```[^\n]*\n?/g, '')
    .replace(/\[([^\]]+)\]\(https?:\/\/[^\s)]+\)/g, '$1')
    .replace(/(\*\*|__)([\s\S]*?)\1/g, '$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*|__/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function previewMessage(raw, role = 'user') {
  const p = parseMessage({ role, content: raw });
  if (p.media) {
    return plainPreview(
      {
        audio: 'Nota de voz',
        image: 'Imagen',
        file: p.title,
        video: 'Video',
        location: 'Ubicación',
        contact: 'Contacto',
      }[p.media] + (p.text ? ` · ${p.text}` : ''),
    );
  }
  if (p.type === 'system') return plainPreview(p.text);
  const content = [p.text, ...(p.files || []).map((f) => `Archivo: ${f}`)].filter(Boolean).join(' · ');
  return plainPreview(content) || 'Sin mensajes';
}

export function quotedPreview(raw, role = 'user') {
  const labels = {
    'nota de voz': 'Nota de voz',
    audio: 'Nota de voz',
    imagen: 'Imagen',
    video: 'Video',
    vídeo: 'Video',
    documento: 'Documento',
    archivo: 'Archivo',
    ubicación: 'Ubicación',
    ubicacion: 'Ubicación',
    contacto: 'Contacto',
  };
  return previewMessage(raw, role).replace(
    /\[(nota de voz|audio|imagen|video|vídeo|documento|archivo|ubicación|ubicacion|contacto)\]/gi,
    (_, label) => labels[label.toLocaleLowerCase()],
  );
}

export function conversationPreview(raw, role) {
  if (!raw) return 'Sin mensajes';
  if (!role) return 'Vista previa no disponible';
  return `${role === 'assistant' ? 'Kiri: ' : ''}${previewMessage(raw, role)}`;
}
