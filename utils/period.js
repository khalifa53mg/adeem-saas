// Month/period formatting. Allocation months are stored as 'YYYY-MM' strings in
// payment_allocations.month — everything here takes that shape as its input.

const MONTH_NAMES_EN = ['January', 'February', 'March', 'April', 'May', 'June',
                        'July', 'August', 'September', 'October', 'November', 'December'];

const MONTH_NAMES_AR = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو',
                        'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];

const MONTH_SHORT_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                        'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const YM_RE = /^(\d{4})-(\d{2})$/;

/** 'YYYY-MM' -> { year, month } (month is 1-12), or null if it isn't a usable month. */
function parseMonth(ym) {
  const m = YM_RE.exec(String(ym || '').trim());
  if (!m) return null;
  const month = parseInt(m[2], 10);
  if (month < 1 || month > 12) return null;
  return { year: parseInt(m[1], 10), month };
}

/** 'YYYY-MM' -> 'June 2026' / 'يونيو 2026'. Unparseable input comes back as-is. */
function monthLabel(ym, isAr) {
  const p = parseMonth(ym);
  if (!p) return String(ym || '');
  const names = isAr ? MONTH_NAMES_AR : MONTH_NAMES_EN;
  return `${names[p.month - 1]} ${p.year}`;
}

/** 'YYYY-MM' -> 'Jun-26'. The compact form used in the payments list. */
function monthShortLabel(ym) {
  const p = parseMonth(ym);
  if (!p) return String(ym || '');
  return `${MONTH_SHORT_EN[p.month - 1]}-${String(p.year).slice(2)}`;
}

/**
 * A list of allocation months as a human phrase. Consecutive months collapse into
 * a range, so a 3-month payment reads 'June — August 2026' rather than listing each.
 * Non-consecutive months stay separate: 'June 2026, September 2026'.
 */
function periodLabel(months, isAr) {
  const parsed = (months || [])
    .map(parseMonth)
    .filter(Boolean)
    .map(p => p.year * 12 + (p.month - 1));

  const ordinals = [...new Set(parsed)].sort((a, b) => a - b);
  if (ordinals.length === 0) return '';

  // Split into runs of consecutive months.
  const runs = [];
  for (const n of ordinals) {
    const last = runs[runs.length - 1];
    if (last && n === last.end + 1) last.end = n;
    else runs.push({ start: n, end: n });
  }

  const names = isAr ? MONTH_NAMES_AR : MONTH_NAMES_EN;
  const name  = n => names[n % 12];
  const year  = n => Math.floor(n / 12);

  // A dash would collide with the ' — ' that describePayment() joins on, so ranges
  // are spelled out: 'June to August 2026' / 'من يونيو إلى أغسطس 2026'.
  const parts = runs.map(r => {
    if (r.start === r.end) return `${name(r.start)} ${year(r.start)}`;
    // Within one year the year is only worth printing once.
    const from = year(r.start) === year(r.end)
      ? name(r.start)
      : `${name(r.start)} ${year(r.start)}`;
    const to = `${name(r.end)} ${year(r.end)}`;
    return isAr ? `من ${from} إلى ${to}` : `${from} to ${to}`;
  });

  return parts.join(isAr ? '، ' : ', ');
}

/**
 * Bare numbers ('1135', '11/12') don't say what they are, so they get a label.
 * Names that already carry one ('Shop 788 B', 'Villa A') are left alone.
 */
function labelled(value, prefixEn, prefixAr, isAr) {
  const v = String(value || '').trim();
  if (!v) return '';
  if (!/^[\d\s/\-]+$/.test(v)) return v;
  return `${isAr ? prefixAr : prefixEn} ${v}`;
}

/**
 * The receipt's Description line — a full sentence saying what the payment was for:
 *   'Rent payment for the month of July 2026 — Flat 12, Building 1135, Road 2804, Manama'
 *   'Rent payment for the months of June to August 2026 — Flat 12, Building 1135'
 *   'دفعة إيجار عن شهر يوليو 2026 — شقة 12، مبنى 1135، المنامة'
 *
 * Derived at render time from the payment row and its allocation months, so it
 * follows the payment if the allocations are edited later. Every part is optional —
 * unit_number, property address and location are all commonly blank in live data.
 *
 * Plenty of live payments carry no allocations at all, and a receipt that doesn't say
 * which month was paid for isn't much of a receipt, so the month of payment_date stands
 * in for them. Allocations always win when they exist.
 *
 * `payment` needs: property_name, unit_number, unit_name, property_address,
 * property_location, payment_date (the columns both receipt queries select).
 * `opts.fallbackAddress` — settings.default_property_address, used only when the
 * property carries no address or location of its own.
 */
function describePayment(payment, months, isAr, opts = {}) {
  const p = payment || {};

  let used = (months || []).map(parseMonth).filter(Boolean);
  if (used.length === 0) {
    // 'YYYY-MM-DD' -> 'YYYY-MM'
    const fromDate = parseMonth(String(p.payment_date || '').trim().slice(0, 7));
    if (fromDate) used = [fromDate];
  }
  const ymList = used.map(m => `${m.year}-${String(m.month).padStart(2, '0')}`);

  // Distinct months decide singular vs plural in the lead-in.
  const monthCount = new Set(used.map(m => m.year * 12 + m.month)).size;

  const period = periodLabel(ymList, isAr);
  let rent = '';
  if (period) {
    if (monthCount === 1) rent = isAr ? `دفعة إيجار عن شهر ${period}` : `Rent payment for the month of ${period}`;
    else                  rent = isAr ? `دفعة إيجار عن الأشهر ${period}` : `Rent payment for the months of ${period}`;
  }

  // Flat before building, matching how the address is read out loud.
  const flat     = labelled(p.unit_number || p.unit_name, 'Flat', 'شقة', isAr);
  const building = labelled(p.property_name, 'Building', 'مبنى', isAr);

  // The building's own address, or the configured default when it has none.
  // Addresses come from textareas, so newlines are flattened into the sentence.
  const flatten   = s => String(s || '').replace(/\s+/g, ' ').trim();
  const ownAddress = [p.property_address, p.property_location].map(flatten).filter(Boolean);
  const address = ownAddress.length
    ? ownAddress
    : [flatten(opts.fallbackAddress)].filter(Boolean);

  const sep   = isAr ? '، ' : ', ';
  const where = [...new Set([flat, building, ...address])].join(sep);

  return [rent, where].filter(Boolean).join(' — ');
}

module.exports = {
  MONTH_NAMES_EN, MONTH_NAMES_AR, MONTH_SHORT_EN,
  parseMonth, monthLabel, monthShortLabel, periodLabel, describePayment
};
