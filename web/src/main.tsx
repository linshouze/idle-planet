import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App as AntApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import dayjs from 'dayjs';
import 'dayjs/locale/zh-cn';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import './styles.css';

dayjs.locale('zh-cn');

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 10_000, refetchOnWindowFocus: true, retry: 1 } },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ConfigProvider
      locale={zhCN}
      button={{ autoInsertSpace: false }}
      theme={{
        token: {
          colorPrimary: '#3b82f6',
          colorSuccess: '#22c55e',
          colorWarning: '#f59e0b',
          colorError: '#ef4444',
          colorText: '#26324b',
          borderRadius: 10,
          fontFamily: "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', 'Noto Sans SC', sans-serif",
        },
      }}
    >
      <AntApp>
        <QueryClientProvider client={queryClient}>
          <App />
        </QueryClientProvider>
      </AntApp>
    </ConfigProvider>
  </StrictMode>,
);
