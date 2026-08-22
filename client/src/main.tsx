import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

if (document.documentElement.dataset.unsupported !== 'true') {
  const rootEl = document.getElementById('root');
  if (rootEl) createRoot(rootEl).render(<App />);
}
