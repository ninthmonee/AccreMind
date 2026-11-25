import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import brandIcon from '../../dsh-plugin/icon.svg?inline';
import { App } from './App';
import './styles.css';

const favicon = document.querySelector<HTMLLinkElement>('link[rel="icon"]') ?? document.createElement('link');
favicon.rel = 'icon';
favicon.type = 'image/svg+xml';
favicon.href = brandIcon;
if (!favicon.isConnected) document.head.append(favicon);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
