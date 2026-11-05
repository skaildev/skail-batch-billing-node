import type { UiState } from "@skail-batch-billing/contracts";

interface Props {
  ui: UiState;
  busy: boolean;
  onClick: () => void;
}

export function StartButton({ ui, busy, onClick }: Props) {
  return (
    <button id="start" type="button" disabled={!ui.enabled || busy} onClick={onClick}>
      {ui.label}
    </button>
  );
}
