// Versión PERSONAL de los paneles: otra página, sin login ni menú del hub. Solo ve y edita lo del dueño del enlace (/p/<token>).
import React from 'react';
import { createRoot } from 'react-dom/client';
import Personal from './Personal.jsx';
import { ErrorBoundary } from '../components/ui.jsx';
import '../styles.css';
const mq = matchMedia('(prefers-color-scheme: dark)');
const apply = () => (document.documentElement.dataset.theme = mq.matches ? 'dark' : 'light');
apply();
mq.addEventListener('change', apply);
createRoot(document.getElementById('root')).render(
  <ErrorBoundary>
    <Personal />
  </ErrorBoundary>,
);
