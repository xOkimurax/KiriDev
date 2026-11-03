import React, { useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { api } from './api.js';
import { Icon, Skeleton } from './components/ui.jsx';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import WhatsApp from './pages/WhatsApp.jsx';
import Persona from './pages/Persona.jsx';
import Memory from './pages/Memory.jsx';
import Mcp from './pages/Mcp.jsx';
import Conversations from './pages/Conversations.jsx';
import Playground from './pages/Playground.jsx';
import Users from './pages/Users.jsx';
import Rules from './pages/Rules.jsx';
import Tasks from './pages/Tasks.jsx';
import Panels from './pages/Panels.jsx';
import Apps from './pages/Apps.jsx';
import Voice from './pages/Voice.jsx';
import Motores from './pages/Motores.jsx';
import Assistant from './components/Assistant.jsx';
const NAV = [
  ['/', 'Inicio', 'home'],
  ['/conversaciones', 'Conversaciones', 'chat'],
  ['/tareas', 'Tareas', 'tasks'],
  ['/paneles', 'Paneles', 'panel'],
  ['/apps', 'Apps', 'globe'],
  ['/voz', 'Voz', 'audio'],
  ['/whatsapp', 'WhatsApp', 'whatsapp'],
  ['/personalidad', 'Personalidades', 'persona'],
  ['/memoria', 'Memoria', 'memory'],
  ['/mcps', 'MCPs', 'mcp'],
  ['/motores', 'Cuentas y motores', 'key'],
  ['/reglas', 'Reglas de respuesta', 'rules'],
  ['/probar', 'Probar agente', 'play'],
  ['/usuarios', 'Usuarios', 'users'],
];
function useTheme() {
  const [theme, set] = useState(() => {
    try {
      return localStorage.getItem('kiri-theme') || 'system';
    } catch {
      return 'system';
    }
  });
  useEffect(() => {
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const apply = () =>
      (document.documentElement.dataset.theme = theme === 'system' ? (mq.matches ? 'dark' : 'light') : theme);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [theme]);
  const cycle = () => {
    const next = theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system';
    set(next);
    try {
      localStorage.setItem('kiri-theme', next);
    } catch {}
  };
  return [theme, cycle];
}
export default function App() {
  const [user, setUser] = useState(undefined),
    [menu, setMenu] = useState(false),
    [refresh, setRefresh] = useState(0),
    [theme, cycle] = useTheme(),
    loc = useLocation();
  useEffect(() => {
    setMenu(false);
  }, [loc.pathname]);
  useEffect(() => {
    api('/auth/me')
      .then(setUser)
      .catch(() => setUser(null));
  }, []);
  if (user === undefined)
    return (
      <div className="boot">
        <Skeleton rows={5} />
      </div>
    );
  if (!user) return <Login onLogin={setUser} />;
  const logout = async () => {
    try {
      await api('/auth/logout', { method: 'POST' });
      setUser(null);
    } catch {
      setUser(null);
    }
  };
  return (
    <div className="shell">
      <header className="mobile-bar">
        <button className="icon-btn" aria-label="Abrir navegación" aria-expanded={menu} onClick={() => setMenu(true)}>
          <Icon name="menu" />
        </button>
        <strong>
          Kiri <span>Hub</span>
        </strong>
      </header>
      {menu && <button className="nav-scrim" aria-label="Cerrar navegación" onClick={() => setMenu(false)} />}
      <aside className={`sidebar ${menu ? 'open' : ''}`}>
        <div className="brand">
          <span className="brand-mark">
            kiri<span>.</span>
          </span>
          <small>Panel del agente</small>
        </div>
        <nav aria-label="Principal">
          {NAV.map(([to, label, icon]) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}
            >
              <Icon name={icon} size={18} />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <button className="theme-control" onClick={cycle} aria-label={`Tema: ${theme}. Cambiar tema`}>
            <Icon name="globe" size={16} />
            <span>Tema: {theme === 'system' ? 'Sistema' : theme === 'dark' ? 'Oscuro' : 'Claro'}</span>
          </button>
          <div className="session">
            <span className="avatar small">{user.username[0].toUpperCase()}</span>
            <span>
              <strong>{user.username}</strong>
              <small>{user.role === 'admin' ? 'Administrador' : 'Solo lectura'}</small>
            </span>
            <button className="icon-btn" onClick={logout} aria-label="Cerrar sesión">
              <Icon name="logout" size={17} />
            </button>
          </div>
        </div>
      </aside>
      <main key={refresh} className={`main ${loc.pathname === '/conversaciones' ? 'main-inbox' : ''}`}>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/paneles" element={<Panels user={user} />} />
          <Route path="/apps" element={<Apps user={user} />} />
          <Route path="/voz" element={<Voice user={user} />} />
          <Route path="/whatsapp" element={<WhatsApp user={user} />} />
          <Route path="/personalidad" element={<Persona user={user} />} />
          <Route path="/memoria" element={<Memory user={user} />} />
          <Route path="/mcps" element={<Mcp user={user} />} />
          <Route path="/motores" element={<Motores user={user} />} />
          <Route path="/reglas" element={<Rules user={user} />} />
          <Route path="/conversaciones" element={<Conversations user={user} />} />
          <Route path="/tareas" element={<Tasks user={user} />} />
          <Route path="/probar" element={<Playground user={user} />} />
          <Route path="/usuarios" element={<Users user={user} />} />
          <Route path="*" element={<Navigate to="/" />} />
        </Routes>
      </main>
      <Assistant user={user} onChanged={() => setRefresh((n) => n + 1)} />
    </div>
  );
}
