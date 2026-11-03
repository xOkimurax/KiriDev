import React, { useState } from 'react';
import { Button, Card, Combo, Icon } from './ui.jsx';
export const clean = (s) => s.replace(/[^\d]/g, '');
export default function NumberList({ title, items, onChange, disabled, contacts = [], hint = '', bare = false, empty = 'Sin números.' }) {
  const [text, setText] = useState('');
  const [pick, setPick] = useState('');
  const nameOf = new Map(contacts.map((c) => [clean(c.wa_jid || c.jid), c.name]));
  const options = contacts
    .filter((c) => !items.includes(clean(c.wa_jid || c.jid)))
    .map((c) => ({ value: clean(c.wa_jid || c.jid), label: c.name || `+${clean(c.wa_jid || c.jid)}`, description: `+${clean(c.wa_jid || c.jid)}` }));
  function add() {
    const numbers = text
      .split(/[\s,;]+/)
      .map(clean)
      .filter((x) => x.length >= 6);
    onChange([...new Set([...items, ...numbers])]);
    setText('');
  }
  const body = (
      <div className="chip-editor">
        <div className="chips">
          {items.length ? (
            items.map((n) => (
              <span className="number-chip" key={n}>
                {nameOf.get(n) ? `${nameOf.get(n)} · ${n}` : n}
                {!disabled && (
                  <button aria-label={`Quitar ${n}`} onClick={() => onChange(items.filter((x) => x !== n))}>
                    <Icon name="close" size={13} />
                  </button>
                )}
              </span>
            ))
          ) : (
            <span className="muted">{empty}</span>
          )}
        </div>
        {!disabled && (
          <div className="stack">
            <div className="row">
              <div style={{ minWidth: 220, flex: 1 }}>
                <Combo label="Contacto conocido" value={pick} onChange={setPick} searchable options={options} placeholder="Elegir…" />
              </div>
              <Button
                variant="secondary"
                disabled={!pick}
                onClick={() => {
                  onChange([...new Set([...items, pick])]);
                  setPick('');
                }}
              >
                Agregar
              </Button>
            </div>
            <div className="row">
              <label style={{ flex: 1 }}>
                Número nuevo
                <input
                  aria-label={`Agregar a ${title.toLowerCase()}`}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      add();
                    }
                  }}
                  placeholder="595981123456 (podés pegar varios)"
                />
              </label>
              <Button variant="secondary" disabled={!text.trim()} onClick={add}>
                Agregar
              </Button>
            </div>
          </div>
        )}
        {hint && <small className="help">{hint}</small>}
        <small className="help">Usá código de país. Podés pegar números separados por coma, espacio o salto de línea.</small>
      </div>
  );
  return bare ? body : <Card title={title}>{body}</Card>;
}
