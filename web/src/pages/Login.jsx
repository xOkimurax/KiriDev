import React, { useState } from 'react';
import { api } from '../api.js';
import { Button } from '../components/ui.jsx';
export default function Login({ onLogin }) {
  const [f, setF] = useState({ username: '', password: '' }),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      onLogin(await api('/auth/login', { method: 'POST', body: f }));
    } catch (x) {
      setError(x.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="login">
      <form className="login-form" onSubmit={submit}>
        <div className="login-brand">
          kiri<span>.</span>
        </div>
        <div>
          <h1>Entrar al panel</h1>
          <p className="muted">Agente de WhatsApp</p>
        </div>
        <div className="login-fields">
          <label>
            Usuario
            <input
              autoFocus
              autoComplete="username"
              value={f.username}
              onChange={(e) => setF({ ...f, username: e.target.value })}
            />
          </label>
          <label>
            Contraseña
            <input
              type="password"
              autoComplete="current-password"
              value={f.password}
              onChange={(e) => setF({ ...f, password: e.target.value })}
            />
          </label>
        </div>
        {error && (
          <p className="alert" role="alert">
            {error}
          </p>
        )}
        <Button disabled={busy || !f.username || !f.password}>{busy ? 'Entrando…' : 'Entrar'}</Button>
      </form>
    </div>
  );
}
