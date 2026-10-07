import { useEffect, useState } from 'react';

const dateFormatter = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric', month: 'long', year: 'numeric',
});
const timeFormatter = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});
const timeZone = timeFormatter.resolvedOptions().timeZone;

export default function DashboardDateTime() {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const refresh = () => setNow(new Date());
    const interval = window.setInterval(refresh, 1000);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, []);

  return <div className="dashboard-date" aria-live="off">
    <time dateTime={now.toISOString()}>{dateFormatter.format(now)}</time>
    <time className="dashboard-clock" dateTime={now.toISOString()} title={`Local time (${timeZone})`}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
      <span>{timeFormatter.format(now)}</span>
    </time>
  </div>;
}
