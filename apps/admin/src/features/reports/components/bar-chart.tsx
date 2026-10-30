import { formatInr } from '@/lib/money';

export interface BarDatum {
  label: string;
  value: number;
}

/**
 * A small dependency-free SVG bar chart with a text alternative: the same figures are in the table that follows it, and the
 * chart carries role="img" with a summary so it is never the only way to read the data. Money values are integer paise.
 */
export function BarChart({ title, data, money = false, color = 'var(--brand)' }: { title: string; data: BarDatum[]; money?: boolean; color?: string }) {
  const W = 640;
  const H = 180;
  const pad = { l: 8, r: 8, t: 12, b: 28 };
  const max = Math.max(1, ...data.map((d) => d.value));
  const slot = (W - pad.l - pad.r) / Math.max(1, data.length);
  const bar = Math.max(2, Math.min(36, slot * 0.7));
  const fmt = (n: number) => (money ? formatInr(n) : String(n));
  const total = data.reduce((a, d) => a + d.value, 0);
  const every = Math.ceil(data.length / 10);
  return (
    <figure className="rounded-xl border border-line bg-surface p-4">
      <figcaption className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm font-semibold text-fg">{title}</span>
        <span className="text-xs text-fg-subtle">Total {fmt(total)} · peak {fmt(max === 1 && total === 0 ? 0 : max)}</span>
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${title}: total ${fmt(total)} over ${data.length} days`} className="h-auto w-full">
        <line x1={pad.l} x2={W - pad.r} y1={H - pad.b} y2={H - pad.b} stroke="var(--line)" />
        {data.map((d, i) => {
          const h = ((H - pad.t - pad.b) * d.value) / max;
          const x = pad.l + slot * i + (slot - bar) / 2;
          return (
            <g key={d.label}>
              <title>{`${d.label}: ${fmt(d.value)}`}</title>
              <rect x={x} y={H - pad.b - h} width={bar} height={Math.max(h, d.value > 0 ? 2 : 0)} rx={2} fill={color} />
              {i % every === 0 ? (
                <text x={x + bar / 2} y={H - 10} textAnchor="middle" fontSize="10" fill="var(--fg-subtle)">
                  {d.label.slice(5)}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
    </figure>
  );
}
