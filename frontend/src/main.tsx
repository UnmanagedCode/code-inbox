import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

// Standalone only: follow the OS theme. Embedded in cc, the bridge has already set data-cc-theme and owns the dark class.
const root = document.documentElement;
if (!root.hasAttribute('data-cc-theme')) {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const apply = () => root.classList.toggle('dark', mq.matches);
  apply();
  mq.addEventListener('change', apply);
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
