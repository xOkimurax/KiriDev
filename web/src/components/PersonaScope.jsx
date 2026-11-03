import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Combo, Switch } from './ui.jsx';

/** Selector "a qué personalidades aplica": value = null (todas) o un arreglo de ids. */
export default function PersonaScope({ value, onChange, disabled }) {
  const [list, setList] = useState([]);
  useEffect(() => { api('/personas').then(setList).catch(() => {}); }, []);
  if (list.length < 2) return null;
  const all = !Array.isArray(value);
  return (
    <div style={{ margin: '8px 0' }}>
      <Combo
        label="Aplica a"
        disabled={disabled}
        value={all ? 'all' : 'some'}
        onChange={(v) => onChange(v === 'all' ? null : list.filter((p) => p.is_default).map((p) => p.id))}
        options={[{ value: 'all', label: 'Todas las personalidades' }, { value: 'some', label: 'Solo algunas personalidades…' }]}
      />
      {!all && (
        <div className="persona-scope-list">
          {list.map((p) => (
            <Switch key={p.id} title={p.name} disabled={disabled} checked={value.includes(p.id)} onChange={(on) => onChange(on ? [...value, p.id] : value.filter((x) => x !== p.id))} />
          ))}
        </div>
      )}
      <p className="help">Cuenta la personalidad que usa cada chat (la del contacto, la de su número o la predeterminada).</p>
    </div>
  );
}
