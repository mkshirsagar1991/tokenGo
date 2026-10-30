import qrcode from 'qrcode-generator';

/** Renders text as an inline SVG QR code (no image/data URLs, so it fits a strict CSP). Fixed black-on-white so scanners work in dark mode too. */
export function QrCode({ value, label, size = 200 }: { value: string; label: string; size?: number }) {
  const qr = qrcode(0, 'M');
  qr.addData(value);
  qr.make();
  const n = qr.getModuleCount();
  const quiet = 4;
  let d = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) d += `M${c + quiet} ${r + quiet}h1v1h-1z`;
    }
  }
  const total = n + quiet * 2;
  return (
    <svg role="img" aria-label={label} width={size} height={size} viewBox={`0 0 ${total} ${total}`} shapeRendering="crispEdges" className="rounded-lg border border-line">
      <rect width={total} height={total} fill="#ffffff" />
      <path d={d} fill="#000000" />
    </svg>
  );
}
