import type { Candle, PortfolioPoint } from '@whalechat/shared';

interface PriceChartProps {
  candles: Candle[];
  positive: boolean;
  height?: number;
}

export function PriceChart({ candles, positive, height = 240 }: PriceChartProps) {
  if (candles.length < 2) {
    return (
      <div className="grid h-[240px] place-items-center text-xs text-slate-500">
        Price history loads when online — cached candles appear here next time.
      </div>
    );
  }
  const width = 720;
  const pad = 8;
  const values = candles.map((c) => c.close);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const x = (i: number) => pad + (i / (candles.length - 1)) * (width - pad * 2);
  const y = (v: number) => pad + (1 - (v - min) / span) * (height - pad * 2);
  const line = candles.map((c, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(2)},${y(c.close).toFixed(2)}`).join(' ');
  const area = `${line} L${x(candles.length - 1).toFixed(2)},${height - pad} L${x(0).toFixed(2)},${height - pad} Z`;
  const stroke = positive ? '#34d3a6' : '#ff6b6b';
  const id = positive ? 'grad-up' : 'grad-down';

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-full w-full" preserveAspectRatio="none" role="img" aria-label="Price chart">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.28" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>
      {[0.25, 0.5, 0.75].map((ratio) => (
        <line
          key={ratio}
          x1={pad}
          x2={width - pad}
          y1={pad + ratio * (height - pad * 2)}
          y2={pad + ratio * (height - pad * 2)}
          stroke="rgba(255,255,255,0.06)"
          strokeDasharray="4 6"
        />
      ))}
      <path d={area} fill={`url(#${id})`} />
      <path d={line} fill="none" stroke={stroke} strokeWidth="2" strokeLinejoin="round" />
      <circle cx={x(candles.length - 1)} cy={y(candles[candles.length - 1]!.close)} r="3.5" fill={stroke} />
    </svg>
  );
}

export function Sparkline({ values, positive }: { values: number[]; positive: boolean }) {
  if (values.length < 2) return <div className="h-8 w-24 rounded bg-white/5" />;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const path = values
    .map((v, i) => `${i === 0 ? 'M' : 'L'}${(i / (values.length - 1)) * 96},${28 - ((v - min) / span) * 24}`)
    .join(' ');
  return (
    <svg viewBox="0 0 96 32" className="h-8 w-24" aria-hidden>
      <path d={path} fill="none" stroke={positive ? '#34d3a6' : '#ff6b6b'} strokeWidth="1.8" />
    </svg>
  );
}

export function PortfolioChart({ history }: { history: PortfolioPoint[] }) {
  if (history.length < 2) {
    return <div className="grid h-40 place-items-center text-xs text-slate-500">Portfolio history builds as you trade.</div>;
  }
  const width = 640;
  const height = 160;
  const min = Math.min(...history.map((p) => p.valueMinor));
  const max = Math.max(...history.map((p) => p.valueMinor));
  const span = max - min || 1;
  const path = history
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${(i / (history.length - 1)) * width},${height - ((p.valueMinor - min) / span) * (height - 20) - 10}`)
    .join(' ');
  const up = (history.at(-1)?.valueMinor ?? 0) >= (history[0]?.valueMinor ?? 0);
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-40 w-full" preserveAspectRatio="none" role="img" aria-label="Portfolio performance">
      <path
        d={`${path} L${width},${height} L0,${height} Z`}
        fill={up ? 'rgba(52,211,166,0.12)' : 'rgba(255,107,107,0.12)'}
      />
      <path d={path} fill="none" stroke={up ? '#34d3a6' : '#ff6b6b'} strokeWidth="2" />
    </svg>
  );
}
