/**
 * General Purpose Formatting & Sanitization Utilities
 */

/**
 * Escapes unsafe characters for safe injection into HTML strings.
 * @param {*} str 
 * @returns {string}
 */
export function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Formats a raw database date string into YYYY-MM-DD.
 * @param {string|null|undefined} d 
 * @returns {string}
 */
export function fmtDate(d) {
  if (!d) return '—';
  return String(d).substring(0, 10);
}

/**
 * Formats a YYYY-MM year-month string into 'MMM, YYYY'.
 * @param {string|null|undefined} ym 
 * @returns {string}
 */
export function formatAmrMonthLabel(ym) {
  if (!ym) return '—';
  const [yr, mo] = ym.split('-');
  const dateObj = new Date(parseInt(yr, 10), parseInt(mo, 10) - 1, 1);
  return dateObj.toLocaleString('en-US', { month: 'short' }) + ', ' + yr;
}

/**
 * Debounce helper function.
 * @param {Function} fn 
 * @param {number} ms 
 * @returns {Function}
 */
export function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

/**
 * Checks if a filename is a SQLite database file.
 * @param {string} filename 
 * @returns {boolean}
 */
export function isSqliteDatabase(filename) {
  return typeof filename === 'string' && filename.toLowerCase().endsWith('.sqlite');
}

/**
 * Checks if a database is a sample/training database (e.g. WHO-TST files).
 * @param {string} name 
 * @returns {boolean}
 */
export function isSampleDb(name) {
  return (name || '').toLowerCase().startsWith('who-tst');
}
