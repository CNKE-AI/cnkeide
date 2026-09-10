import React from 'react';
import ReactDOM from 'react-dom/client';
import PptPage from './pages/PptPage';
import { AppProvider } from './store/AppProvider';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppProvider>
      <PptPage />
    </AppProvider>
  </React.StrictMode>,
);