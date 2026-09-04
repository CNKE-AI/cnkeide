import React, { useEffect } from 'react';
import { AppProvider } from './store/AppProvider';
import MainLayout from './components/MainLayout';
import { useThemeStore } from './store/themeStore';

const App: React.FC = () => {
  const theme = useThemeStore((s) => s.theme);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'light') {
      root.classList.add('light');
    } else {
      root.classList.remove('light');
    }
  }, [theme]);

  return (
    <AppProvider>
      <MainLayout />
    </AppProvider>
  );
};

export default App;
