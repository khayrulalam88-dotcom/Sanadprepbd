import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';

declare global {
  interface Window {
    __SANADPREP_MOUNTED__?: boolean;
  }
}

const rootElement = document.getElementById('root');
if (rootElement) {
  window.__SANADPREP_MOUNTED__ = true;
  createRoot(rootElement).render(<App />);
}
