import { useEffect, useState } from 'react';
import { useSim } from '../state/sim';

export function Toast() {
  const toast = useSim((s) => s.toast);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!toast) return;
    setVisible(true);
    const t = setTimeout(() => setVisible(false), 3500);
    return () => clearTimeout(t);
  }, [toast]);
  if (!toast || !visible) return null;
  return (
    <div className="overlay card toast" role="status">
      {toast.text}
    </div>
  );
}
