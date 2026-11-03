import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import {
  Badge,
  Button,
  Card,
  Drawer,
  Empty,
  InlineConfirm,
  PageHead,
  Segmented,
  Skeleton,
  fmtDate,
  useToast,
} from '../components/ui.jsx';
export default function Users({ user }) {
  const admin = user.role === 'admin',
    [list, setList] = useState([]),
    [drawer, setDrawer] = useState(false),
    [f, setF] = useState({ username: '', password: '', role: 'viewer' }),
    [pw, setPw] = useState({ current: '', next: '' }),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(admin),
    [toast, toastNode] = useToast();
  const load = () =>
    admin &&
    api('/users')
      .then(setList)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  useEffect(() => {
    load();
  }, []);
  async function create() {
    try {
      await api('/users', { method: 'POST', body: f });
      setDrawer(false);
      setF({ username: '', password: '', role: 'viewer' });
      toast('Usuario creado');
      load();
    } catch (e) {
      toast(e.message, 'err');
    }
  }
  async function remove(id) {
    try {
      await api(`/users/${id}`, { method: 'DELETE' });
      toast('Usuario eliminado');
      load();
    } catch (e) {
      toast(e.message, 'err');
    }
  }
  async function password(e) {
    e.preventDefault();
    try {
      await api('/auth/password', { method: 'POST', body: pw });
      setPw({ current: '', next: '' });
      toast('Contraseña actualizada');
    } catch (x) {
      toast(x.message, 'err');
    }
  }
  return (
    <>
      <PageHead title="Usuarios">
        {admin && (
          <Button icon="plus" onClick={() => setDrawer(true)}>
            Nuevo usuario
          </Button>
        )}
      </PageHead>
      {admin && (
        <Card title="Acceso al panel">
          {error && (
            <div className="error-block">
              No se pudo cargar la lista: {error}
              <Button variant="secondary" onClick={load}>
                Reintentar
              </Button>
            </div>
          )}
          {loading ? (
            <Skeleton rows={4} />
          ) : list.length ? (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Usuario</th>
                    <th>Rol</th>
                    <th>Creado</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {list.map((u) => (
                    <tr key={u.id}>
                      <td>
                        <strong className="table-title">{u.username}</strong>
                        {u.username === user.username && <span className="muted"> · vos</span>}
                      </td>
                      <td>{u.role === 'admin' ? 'Administrador' : 'Solo lectura'}</td>
                      <td className="mono">{fmtDate(u.created_at)}</td>
                      <td>
                        {u.username !== user.username && (
                          <InlineConfirm
                            label="Eliminar"
                            message={`¿Quitar acceso a ${u.username}?`}
                            onConfirm={() => remove(u.id)}
                          />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty title="Sin usuarios" />
          )}
        </Card>
      )}
      <Card title="Cambiar mi contraseña" className="mt">
        <form className="stack" onSubmit={password} style={{ maxWidth: 380 }}>
          <label>
            Contraseña actual
            <input
              type="password"
              autoComplete="current-password"
              value={pw.current}
              onChange={(e) => setPw({ ...pw, current: e.target.value })}
            />
          </label>
          <label>
            Nueva contraseña
            <input
              type="password"
              autoComplete="new-password"
              value={pw.next}
              onChange={(e) => setPw({ ...pw, next: e.target.value })}
            />
          </label>
          <div>
            <Button disabled={!pw.current || !pw.next}>Actualizar contraseña</Button>
          </div>
        </form>
      </Card>
      {drawer && (
        <Drawer
          title="Nuevo usuario"
          onClose={() => setDrawer(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setDrawer(false)}>
                Cancelar
              </Button>
              <Button disabled={!f.username.trim() || !f.password} onClick={create}>
                Crear usuario
              </Button>
            </>
          }
        >
          <label>
            Usuario
            <input autoFocus value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} />
          </label>
          <label>
            Contraseña
            <input
              type="password"
              autoComplete="new-password"
              value={f.password}
              onChange={(e) => setF({ ...f, password: e.target.value })}
            />
          </label>
          <Segmented
            label="Rol"
            value={f.role}
            onChange={(v) => setF({ ...f, role: v })}
            options={[
              { value: 'viewer', label: 'Solo lectura' },
              { value: 'admin', label: 'Administrador' },
            ]}
          />
        </Drawer>
      )}
      {toastNode}
    </>
  );
}
