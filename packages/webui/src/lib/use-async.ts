import { type DependencyList, useCallback, useEffect, useRef, useState } from 'react';

export interface AsyncState<T> {
  data: T | undefined;
  error: Error | null;
  loading: boolean;
  reload: () => void;
}

/**
 * 运行异步读取并在依赖变化时重跑。重新加载期间保留上一份数据（避免列表闪空），
 * 过期的响应会被丢弃，不会覆盖较新的结果。
 */
export function useAsync<T>(load: () => Promise<T>, deps: DependencyList): AsyncState<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const serial = useRef(0);

  useEffect(() => {
    const id = ++serial.current;
    setLoading(true);
    load().then(
      (value) => {
        if (id !== serial.current) return;
        setData(value);
        setError(null);
        setLoading(false);
      },
      (err: unknown) => {
        if (id !== serial.current) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        setLoading(false);
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload };
}
