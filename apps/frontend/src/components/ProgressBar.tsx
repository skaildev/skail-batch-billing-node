export function ProgressBar({ done, total }: { done: number; total: number }) {
  return <progress max={total} value={done} />;
}
