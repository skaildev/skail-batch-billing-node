interface Props {
  sizes: readonly number[];
  value: number;
  disabled: boolean;
  onChange: (size: number) => void;
}

export function BatchSizeSelect({ sizes, value, disabled, onChange }: Props) {
  return (
    <>
      <label htmlFor="size">Batch size</label>
      <select id="size" value={value} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))}>
        {sizes.map((size) => (
          <option key={size} value={size}>
            {size} invoices
          </option>
        ))}
      </select>
    </>
  );
}
