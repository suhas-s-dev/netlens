import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { sim, useSim } from './state/sim';
import { App } from './ui/App';
import './ui/styles.css';

// Dev-only handle for debugging and perf checks from the console.
if (import.meta.env.DEV) Object.assign(window, { __netlens: { sim, useSim } });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
