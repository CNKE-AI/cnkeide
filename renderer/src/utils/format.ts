// Format a numeric timestamp (ms) to 'YYYY-MM-DD HH:mm:ss'
export function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (n: number): string => {
    return String(n).padStart(2, '0');
  };
  const yyyy = String(date.getFullYear());
  const mm = pad(date.getMonth() + 1);
  const dd = pad(date.getDate());
  const hh = pad(date.getHours());
  const mi = pad(date.getMinutes());
  const ss = pad(date.getSeconds());
  return yyyy + '-' + mm + '-' + dd + ' ' + hh + ':' + mi + ':' + ss;
}
