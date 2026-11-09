import { createContext, useContext, type ReactNode } from 'react';
import { App as AntApp } from 'antd';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, post } from './api/client';
import { fireConfetti } from './components/Confetti';
import type { Badge, User } from './api/types';

interface MeData {
  user: User;
  badge: Badge;
  wishUpdates: number;
  preferredHandoff: string | null;
  aiEnabled: boolean;
}

const AuthContext = createContext<MeData | null>(null);

export function useMeQuery() {
  return useQuery({
    queryKey: ['me'],
    queryFn: async (): Promise<MeData | null> => {
      try {
        return await api<MeData>('/api/me');
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    refetchInterval: 30_000,
    retry: false,
  });
}

export function AuthProvider({ me, children }: { me: MeData; children: ReactNode }) {
  return <AuthContext.Provider value={me}>{children}</AuthContext.Provider>;
}

export function useAuth(): MeData {
  const v = useContext(AuthContext);
  if (!v) throw new Error('useAuth 必须在登录后使用');
  return v;
}

/**
 * 执行一个会改变数据的操作：成功后提示并刷新所有查询，失败时提示服务端给出的原因。
 * 返回操作是否成功。
 */
export function useAct() {
  const { message } = AntApp.useApp();
  const qc = useQueryClient();
  return async (fn: () => Promise<unknown>, successMessage?: string): Promise<boolean> => {
    try {
      await fn();
      if (successMessage) message.success(successMessage);
      await qc.invalidateQueries();
      return true;
    } catch (e) {
      message.error(e instanceof Error ? e.message : '操作失败，请重试');
      // 状态可能已被别人改变，刷新后让界面显示最新状态
      await qc.invalidateQueries();
      return false;
    }
  };
}

/** 确认弹窗。用 App 上下文里的 modal，才能带上主题色和中文文案。确认后执行操作并刷新数据。 */
export function useConfirm() {
  const { modal } = AntApp.useApp();
  const act = useAct();
  return (title: string, content: string, okText: string, run: () => Promise<unknown>, done?: string, danger = false) =>
    modal.confirm({ title, content, okText, cancelText: '取消', okButtonProps: { danger }, onOk: () => act(run, done) });
}

/** 确认收货：成功后若命中自己的进行中心愿，问一句「心愿已实现吗」。 */
export function useCompleteDeal() {
  const { message, modal } = AntApp.useApp();
  const qc = useQueryClient();
  return async (requestId: number) => {
    try {
      const r = await api<{ ok: true; wishPrompt: { wishId: number; content: string } | null }>(`/api/requests/${requestId}/complete`, {
        method: 'POST',
        json: {},
      });
      message.success('交易已完成');
      fireConfetti();
      await qc.invalidateQueries();
      const prompt = r.wishPrompt;
      if (prompt) {
        modal.confirm({
          title: '小星：心愿已实现吗？',
          content: `这件商品匹配你的心愿「${prompt.content}」。标记实现后心愿结束并计入已实现。`,
          okText: '已实现',
          cancelText: '还没有',
          onOk: async () => {
            await post(`/api/wishes/${prompt.wishId}/fulfill`);
            message.success('心愿已实现');
            await qc.invalidateQueries();
          },
        });
      }
    } catch (e) {
      message.error(e instanceof Error ? e.message : '操作失败，请重试');
      await qc.invalidateQueries();
    }
  };
}
