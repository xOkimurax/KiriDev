import { createContext, useContext } from 'react';
import { api as baseApi } from '../api.js';

/** Cliente de la API de paneles: el hub usa /api/...; la página personal usa /api/p/<token>/... (mismas rutas, solo las del dueño del enlace). */
export const PanelApiContext = createContext({ api: baseApi, url: (p) => `/api${p}`, scope: 'hub' });
export const usePanelApi = () => useContext(PanelApiContext);
